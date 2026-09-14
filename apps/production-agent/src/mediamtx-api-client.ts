import { request, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import {
  isMediaMtxApiCredentials,
  MediaMtxApiCredentialsError,
  type MediaMtxApiCredentials,
} from './mediamtx-api-credentials.js';

const RESPONSE_LIMIT_BYTES = 65_536;
const PATH_NAME_LIMIT = 256;

const ClientConfigSchema = z.strictObject({
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1024).max(65_535),
  credential: z.custom<MediaMtxApiCredentials>(isMediaMtxApiCredentials),
}).readonly();

const PathItemSchema = z.object({
  name: z.string().min(1).max(PATH_NAME_LIMIT),
  available: z.boolean(),
  online: z.boolean(),
}).passthrough();

const PathsResponseSchema = z.object({
  itemCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  items: z.array(PathItemSchema),
}).passthrough();

export type MediaMtxPathStatus = {
  readonly name: string;
  readonly available: boolean;
  readonly online: boolean;
};

export type MediaMtxPathsSnapshot = {
  readonly itemCount: number;
  readonly pageCount: number;
  readonly items: readonly MediaMtxPathStatus[];
};

export interface MediaMtxApiClientPort {
  readonly listPaths: (signal: AbortSignal) => Promise<MediaMtxPathsSnapshot>;
}

export type MediaMtxApiClientConfig = {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly credential: MediaMtxApiCredentials;
};

export interface MediaMtxApiClientFactoryPort {
  readonly create: (config: MediaMtxApiClientConfig) => MediaMtxApiClientPort;
}

export type MediaMtxApiClientErrorCode =
  | 'ABORTED'
  | 'AUTH_FAILED'
  | 'CONFIG_INVALID'
  | 'CREDENTIAL_DISPOSED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'REQUEST_FAILED'
  | 'RESPONSE_TOO_LARGE'
  | 'SERVER_ERROR';

const errorMessages = {
  ABORTED: 'MediaMTX API request was aborted',
  AUTH_FAILED: 'MediaMTX API authentication failed',
  CONFIG_INVALID: 'Invalid MediaMTX API client configuration',
  CREDENTIAL_DISPOSED: 'MediaMTX API credentials are unavailable',
  HTTP_ERROR: 'MediaMTX API returned an unsuccessful response',
  MALFORMED_RESPONSE: 'MediaMTX API returned a malformed response',
  REQUEST_FAILED: 'MediaMTX API request failed',
  RESPONSE_TOO_LARGE: 'MediaMTX API response exceeds the size limit',
  SERVER_ERROR: 'MediaMTX API server failed',
} as const satisfies Record<MediaMtxApiClientErrorCode, string>;

export class MediaMtxApiClientError extends Error {
  public constructor(public readonly code: MediaMtxApiClientErrorCode) {
    super(errorMessages[code]);
    this.name = 'MediaMtxApiClientError';
  }
}

export class MediaMtxApiClient implements MediaMtxApiClientPort {
  readonly #host: '127.0.0.1';
  readonly #port: number;
  readonly #credential: MediaMtxApiCredentials;

  public constructor(configInput: unknown) {
    const config = ClientConfigSchema.safeParse(configInput);
    if (!config.success) throw new MediaMtxApiClientError('CONFIG_INVALID');
    this.#host = config.data.host;
    this.#port = config.data.port;
    this.#credential = config.data.credential;
  }

  public async listPaths(signal: AbortSignal): Promise<MediaMtxPathsSnapshot> {
    if (signal.aborted) throw new MediaMtxApiClientError('ABORTED');
    try {
      return await this.#credential.withBasicAuthorization((authorization) => this.requestPaths(authorization, signal));
    } catch (error) {
      if (error instanceof MediaMtxApiClientError) throw error;
      if (error instanceof MediaMtxApiCredentialsError) throw new MediaMtxApiClientError('CREDENTIAL_DISPOSED');
      throw new MediaMtxApiClientError('REQUEST_FAILED');
    }
  }

  private requestPaths(
    authorization: string,
    signal: AbortSignal,
  ): Promise<MediaMtxPathsSnapshot> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeResponse: IncomingMessage | undefined;
      const finish = (result: MediaMtxPathsSnapshot | MediaMtxApiClientError): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (result instanceof MediaMtxApiClientError) reject(result);
        else resolve(result);
      };
      const abort = (): void => {
        activeResponse?.destroy();
        activeRequest.destroy();
        finish(new MediaMtxApiClientError('ABORTED'));
      };
      signal.addEventListener('abort', abort, { once: true });
      const activeRequest = request({
        host: this.#host,
        port: this.#port,
        method: 'GET',
        path: '/v3/paths/list',
        headers: { Authorization: authorization, Accept: 'application/json' },
      }, (response) => {
        activeResponse = response;
        if (response.statusCode === 401) {
          finish(new MediaMtxApiClientError('AUTH_FAILED'));
          response.destroy();
          return;
        }
        if (response.statusCode !== undefined && response.statusCode >= 500) {
          finish(new MediaMtxApiClientError('SERVER_ERROR'));
          response.destroy();
          return;
        }
        if (response.statusCode !== 200) {
          finish(new MediaMtxApiClientError('HTTP_ERROR'));
          response.destroy();
          return;
        }
        this.consumeResponse(response, () => activeRequest.destroy(), finish);
      });
      activeRequest.once('error', () => {
        finish(new MediaMtxApiClientError(signal.aborted ? 'ABORTED' : 'REQUEST_FAILED'));
      });
      activeRequest.end();
    });
  }

  private consumeResponse(
    response: IncomingMessage,
    destroyRequest: () => void,
    finish: (result: MediaMtxPathsSnapshot | MediaMtxApiClientError) => void,
  ): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      const nextBytes = bytes + chunk.byteLength;
      if (nextBytes > RESPONSE_LIMIT_BYTES) {
        finish(new MediaMtxApiClientError('RESPONSE_TOO_LARGE'));
        response.destroy();
        destroyRequest();
        return;
      }
      chunks.push(chunk);
      bytes = nextBytes;
    });
    response.once('error', () => finish(new MediaMtxApiClientError('REQUEST_FAILED')));
    response.once('end', () => {
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      } catch {
        finish(new MediaMtxApiClientError('MALFORMED_RESPONSE'));
        return;
      }
      const parsed = PathsResponseSchema.safeParse(payload);
      if (!parsed.success) {
        finish(new MediaMtxApiClientError('MALFORMED_RESPONSE'));
        return;
      }
      const names = new Set<string>();
      const statuses: MediaMtxPathStatus[] = [];
      for (const item of parsed.data.items) {
        if (names.has(item.name)) {
          finish(new MediaMtxApiClientError('MALFORMED_RESPONSE'));
          return;
        }
        names.add(item.name);
        statuses.push(Object.freeze({ name: item.name, available: item.available, online: item.online }));
      }
      finish(Object.freeze({
        itemCount: parsed.data.itemCount,
        pageCount: parsed.data.pageCount,
        items: Object.freeze(statuses),
      }));
    });
  }
}

export class MediaMtxApiClientFactory implements MediaMtxApiClientFactoryPort {
  public create = (config: MediaMtxApiClientConfig): MediaMtxApiClient => new MediaMtxApiClient(config);
}
