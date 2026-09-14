import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  LocalMediaRuntimeConfigSchema,
  MediaMtxApiClientFactory,
  MediaMtxApiCredentialFactory,
  MediaMtxService,
  NodeEphemeralRuntimeFiles,
  NodeProcessSpawner,
  NodeScheduler,
} from '../src/index.js';

const OPERATION_TIMEOUT_MS = 2_000;
const PATH_NAMES = ['court-1', 'court-2', 'court-3', 'court-4'] as const;
const COURT_IDS = [
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004',
] as const;

class SmokeTimeoutError extends Error {
  public constructor(operation: string) {
    super(`Timed out during MediaMTX smoke ${operation}`);
    this.name = 'SmokeTimeoutError';
  }
}

async function bounded<Result>(operation: string, promise: Promise<Result>): Promise<Result> {
  const controller = new AbortController();
  const timeout = new NodeScheduler().wait(OPERATION_TIMEOUT_MS, controller.signal)
    .then((): never => { throw new SmokeTimeoutError(operation); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    controller.abort();
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new TypeError('Expected loopback TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  });
}

function writePaths(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    itemCount: PATH_NAMES.length,
    pageCount: 1,
    items: PATH_NAMES.map((name) => ({ name, available: false, online: false })),
  }));
}

function removeRuntimeRoot(rootPath: string): void {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      unlinkSync(join(entryPath, 'mediamtx.yml'));
      rmdirSync(entryPath);
    } else {
      unlinkSync(entryPath);
    }
  }
  rmdirSync(rootPath);
}

it('runs the public MediaMtxService lifecycle through real local adapters', async () => {
  // Given
  const authorizationHeaders: string[] = [];
  let childReady = false;
  const handler: RequestListener = (request, response) => {
    if (request.method === 'POST' && request.url === '/child-ready') {
      childReady = true;
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'GET' || request.url !== '/v3/paths/list') {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      response.writeHead(401).end();
      return;
    }
    authorizationHeaders.push(authorization);
    if (!childReady) {
      response.writeHead(503).end();
      return;
    }
    writePaths(response);
  };
  const apiServer = createServer(handler);
  let rootPath: string | null = null;
  let service: MediaMtxService | null = null;
  let testFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    const apiPort = await bounded('API listen', listen(apiServer));
    rootPath = mkdtempSync(join(tmpdir(), 'kpl-mediamtx-service-'));
    chmodSync(rootPath, 0o700);
    const signalPath = join(rootPath, 'sigint');
    const pidPath = join(rootPath, 'pid');
    const executablePath = join(rootPath, 'mediamtx-node');
    const childScript = `#!${process.execPath}\n`
      + `const fs=require('node:fs');const http=require('node:http');const net=require('node:net');\n`
      + `const hold=net.createServer();hold.listen(0,'127.0.0.1',()=>{`
      + `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid),{mode:0o600});`
      + `const request=http.request({host:'127.0.0.1',port:${apiPort},method:'POST',path:'/child-ready'},response=>response.resume());`
      + `request.on('error',()=>process.exit(2));request.end();});\n`
      + `process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(signalPath)},'SIGINT',{mode:0o600});`
      + `hold.close(()=>process.exit(0));});\n`;
    writeFileSync(executablePath, childScript, { mode: 0o700 });
    chmodSync(executablePath, 0o700);
    const config = LocalMediaRuntimeConfigSchema.parse({
      courtIds: COURT_IDS,
      mediaMtxVersion: '1.21.0',
      mediaMtxExecutablePath: executablePath,
      ffmpegExecutablePath: process.execPath,
      runtimeDirectoryPath: rootPath,
      runtimeDirectoryMode: 0o700,
      configFileMode: 0o600,
      persistence: 'ephemeral',
      startupTimeoutMs: OPERATION_TIMEOUT_MS,
      healthTimeoutMs: OPERATION_TIMEOUT_MS,
      stopGraceMs: 100,
      bindings: {
        apiHost: '127.0.0.1', apiPort, srtHost: '127.0.0.1', srtPort: apiPort,
        courts: COURT_IDS.map((courtId, index) => ({ courtId, pathName: PATH_NAMES[index] })),
        videoInputs: [{
          deviceId: '50000000-0000-4000-8000-000000000001',
          kind: 'v4l2', devicePath: '/dev/video0', inputPixelFormat: 'yuyv422',
        }],
        audioInputs: [],
      },
    });
    service = new MediaMtxService({
      config,
      runtimeFiles: new NodeEphemeralRuntimeFiles(),
      spawner: new NodeProcessSpawner(),
      scheduler: new NodeScheduler(),
      credentialFactory: new MediaMtxApiCredentialFactory({ randomBytes }),
      apiClientFactory: new MediaMtxApiClientFactory(),
    });

    // When
    await bounded('start', service.start());
    const artifactDirectories = readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map(({ name }) => name);
    const inspection = await bounded('inspection', service.inspectPaths(new AbortController().signal));
    await bounded('stop', service.stop());

    // Then
    const uniqueAuthorizationHeaders = new Set(authorizationHeaders);
    expect(authorizationHeaders.length).toBeGreaterThanOrEqual(2);
    expect(uniqueAuthorizationHeaders.size).toBe(1);
    expect([...uniqueAuthorizationHeaders].every((header) => header.startsWith('Basic '))).toBe(true);
    expect(inspection.items).toHaveLength(4);
    expect(readFileSync(signalPath, 'utf8')).toBe('SIGINT');
    expect(service.status()).toEqual({ state: 'idle' });
    expect(artifactDirectories).toHaveLength(1);
    expect(readdirSync(rootPath, { withFileTypes: true }).some((entry) => entry.isDirectory())).toBe(false);
    expect(Number.parseInt(readFileSync(pidPath, 'utf8'), 10)).toBeGreaterThan(0);
  } catch (error) {
    testFailure = error;
  } finally {
    if (service !== null) {
      try { await bounded('cleanup stop', service.stop()); } catch (error) { cleanupFailures.push(error); }
    }
    try { await bounded('API close', closeServer(apiServer)); } catch (error) { cleanupFailures.push(error); }
    if (rootPath !== null) {
      try { removeRuntimeRoot(rootPath); } catch (error) { cleanupFailures.push(error); }
    }
  }
  const [cleanupFailure] = cleanupFailures;
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
