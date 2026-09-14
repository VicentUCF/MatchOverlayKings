import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MediaMtxApiClient, MediaMtxApiClientError } from '../src/mediamtx-api-client.js';
import { createMediaMtxApiCredentials } from '../src/mediamtx-api-credentials.js';

type LoopbackServer = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error('Deferred was not initialized');
      resolvePromise();
    },
  };
}

function credentials() {
  return createMediaMtxApiCredentials({ randomBytes: (size) => new Uint8Array(size).fill(0x55) });
}

async function startLoopbackServer(handler: RequestListener): Promise<LoopbackServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Expected TCP server address');
  }
  return { port: address.port, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function withServer<Result>(handler: RequestListener, test: (port: number) => Promise<Result>): Promise<Result> {
  const server = await startLoopbackServer(handler);
  try {
    return await test(server.port);
  } finally {
    await server.close();
  }
}

function client(port: number, credential = credentials()): MediaMtxApiClient {
  return new MediaMtxApiClient({ host: '127.0.0.1', port, credential });
}

function writeJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('MediaMTX API client', () => {
  it('sends one authenticated fixed-path request and preserves an immutable response snapshot', async () => {
    // Given
    const credential = credentials();
    const authorization = await credential.withBasicAuthorization((header) => header);
    let requestPath = '';
    let requestMethod = '';
    let requestAuthorization = '';

    await withServer((request, response) => {
      requestPath = request.url ?? '';
      requestMethod = request.method ?? '';
      requestAuthorization = request.headers.authorization ?? '';
      writeJson(response, {
        itemCount: 2,
        pageCount: 1,
        items: [
          { name: 'court-1', available: true, online: true, source: { type: 'publisher' } },
          { name: 'court-2', available: false, online: false, bytesReceived: 0 },
        ],
      });
    }, async (port) => {
      // When
      const statuses = await client(port, credential).listPaths(new AbortController().signal);

      // Then
      expect(requestMethod).toBe('GET');
      expect(requestPath).toBe('/v3/paths/list');
      expect(requestAuthorization).toBe(authorization);
      expect(statuses).toEqual({
        itemCount: 2,
        pageCount: 1,
        items: [
          { name: 'court-1', available: true, online: true },
          { name: 'court-2', available: false, online: false },
        ],
      });
      expect(Object.isFrozen(statuses)).toBe(true);
      expect(Object.isFrozen(statuses.items)).toBe(true);
      expect(Object.isFrozen(statuses.items[0])).toBe(true);
    });
  });

  it('distinguishes unauthorized, terminal client, and retryable server responses', async () => {
    // Given
    const cases = [
      { statusCode: 401, code: 'AUTH_FAILED' },
      { statusCode: 403, code: 'HTTP_ERROR' },
      { statusCode: 503, code: 'SERVER_ERROR' },
    ] as const;

    // When / Then
    for (const current of cases) {
      await withServer((_request, response) => writeJson(response, { private: 'secret' }, current.statusCode), async (port) => {
        await expect(client(port).listPaths(new AbortController().signal)).rejects.toMatchObject({
          code: current.code,
        });
      });
    }
  });

  it('rejects malformed roots, items, and duplicate path names', async () => {
    // Given
    const bodies: readonly unknown[] = [
      { pageCount: 1, items: [] },
      { itemCount: 1, pageCount: 1, items: [{ name: '', available: true, online: true }] },
      {
        itemCount: 2,
        pageCount: 1,
        items: [
          { name: 'court-1', available: true, online: true },
          { name: 'court-1', available: false, online: false },
        ],
      },
    ];

    // When / Then
    for (const body of bodies) {
      await withServer((_request, response) => writeJson(response, body), async (port) => {
        await expect(client(port).listPaths(new AbortController().signal)).rejects.toMatchObject({
          code: 'MALFORMED_RESPONSE',
        });
      });
    }
  });

  it('rejects a chunked response exceeding 64 KiB before concatenation', async () => {
    // Given
    const firstChunk = Buffer.alloc(65_536, 0x61);

    await withServer((_request, response) => {
      response.writeHead(200, { 'transfer-encoding': 'chunked' });
      response.write(firstChunk);
      response.end('x');
    }, async (port) => {
      // When / Then
      await expect(client(port).listPaths(new AbortController().signal)).rejects.toMatchObject({
        code: 'RESPONSE_TOO_LARGE',
      });
    });
  });

  it('does not request when already aborted and destroys a pending request when aborted', async () => {
    // Given
    let received = false;
    const reachedServer = deferred();
    const controller = new AbortController();

    await withServer((request: IncomingMessage, response: ServerResponse) => {
      received = true;
      reachedServer.resolve();
      request.once('close', () => response.end());
    }, async (port) => {
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();

      // When
      await expect(client(port).listPaths(alreadyAborted.signal)).rejects.toMatchObject({ code: 'ABORTED' });
      const pending = client(port).listPaths(controller.signal);
      await reachedServer.promise;
      controller.abort();

      // Then
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
      expect(received).toBe(true);
    });
  });

  it('maps loopback connection failure to a typed request failure', async () => {
    // Given
    const server = await startLoopbackServer((_request, response) => response.end());
    await server.close();

    // When / Then
    await expect(client(server.port).listPaths(new AbortController().signal)).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
    });
    await expect(client(server.port).listPaths(new AbortController().signal)).rejects.toBeInstanceOf(MediaMtxApiClientError);
  });

  it('fails before transport when credentials have been disposed', async () => {
    // Given
    const credential = credentials();
    credential.dispose();

    // When
    const listing = client(9997, credential).listPaths(new AbortController().signal);

    // Then
    await expect(listing).rejects.toEqual(new MediaMtxApiClientError('CREDENTIAL_DISPOSED'));
  });
});
