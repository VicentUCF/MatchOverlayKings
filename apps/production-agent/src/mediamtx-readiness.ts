import {
  MediaMtxApiClientError,
  type MediaMtxApiClientPort,
  type MediaMtxPathsSnapshot,
} from './mediamtx-api-client.js';
import type { ManagedProcessPort } from './managed-process.js';
import type { SchedulerPort } from './process-stop.js';

const RETRY_INTERVAL_MS = 50;
const REQUIRED_PATH_COUNT = 4;

export type MediaMtxReadinessOptions = {
  readonly client: MediaMtxApiClientPort;
  readonly process: ManagedProcessPort;
  readonly scheduler: SchedulerPort;
  readonly expectedPathNames: readonly string[];
  readonly startupTimeoutMs: number;
  readonly probeController: AbortController;
};

export type MediaMtxReadinessErrorCode =
  | 'ABORTED'
  | 'AUTH_FAILED'
  | 'CONFIG_INVALID'
  | 'CREDENTIAL_DISPOSED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'PROCESS_EXITED'
  | 'PROBE_FAILED'
  | 'RESPONSE_TOO_LARGE'
  | 'STARTUP_TIMEOUT';

const errorMessages = {
  ABORTED: 'MediaMTX readiness was aborted',
  AUTH_FAILED: 'MediaMTX readiness authentication failed',
  CONFIG_INVALID: 'Invalid MediaMTX readiness configuration',
  CREDENTIAL_DISPOSED: 'MediaMTX readiness credentials are unavailable',
  HTTP_ERROR: 'MediaMTX readiness received a terminal HTTP response',
  MALFORMED_RESPONSE: 'MediaMTX readiness received a malformed response',
  PROCESS_EXITED: 'MediaMTX exited before readiness',
  PROBE_FAILED: 'MediaMTX readiness probe failed',
  RESPONSE_TOO_LARGE: 'MediaMTX readiness response exceeds the size limit',
  STARTUP_TIMEOUT: 'MediaMTX readiness timed out',
} as const satisfies Record<MediaMtxReadinessErrorCode, string>;

export class MediaMtxReadinessError extends Error {
  public constructor(public readonly code: MediaMtxReadinessErrorCode) {
    super(errorMessages[code]);
    this.name = 'MediaMtxReadinessError';
  }
}

type RaceResult =
  | { readonly state: 'ready'; readonly snapshot: MediaMtxPathsSnapshot }
  | { readonly state: 'probeFailed'; readonly error: MediaMtxReadinessError }
  | { readonly state: 'processExited' }
  | { readonly state: 'timedOut' };

export async function waitForMediaMtxReadiness(
  options: MediaMtxReadinessOptions,
): Promise<MediaMtxPathsSnapshot> {
  assertExpectedPaths(options.expectedPathNames);
  const timeoutController = new AbortController();
  const timeout = options.scheduler.wait(options.startupTimeoutMs, timeoutController.signal)
    .then((): RaceResult => ({ state: 'timedOut' }));
  const processExited = options.process.close.then((): RaceResult => ({ state: 'processExited' }));
  const probing = probeUntilReady(options).then(
    (snapshot): RaceResult => ({ state: 'ready', snapshot }),
    (error: unknown): RaceResult => ({
      state: 'probeFailed',
      error: error instanceof MediaMtxReadinessError ? error : new MediaMtxReadinessError('PROBE_FAILED'),
    }),
  );
  const result = await Promise.race([processExited, timeout, probing]);
  timeoutController.abort();
  options.probeController.abort();
  if (result.state === 'processExited' || result.state === 'timedOut') await probing;
  switch (result.state) {
    case 'ready':
      return result.snapshot;
    case 'probeFailed':
      throw result.error;
    case 'processExited':
      throw new MediaMtxReadinessError('PROCESS_EXITED');
    case 'timedOut':
      throw new MediaMtxReadinessError('STARTUP_TIMEOUT');
    default:
      return assertNever(result);
  }
}

async function probeUntilReady(
  options: MediaMtxReadinessOptions,
): Promise<MediaMtxPathsSnapshot> {
  while (true) {
    if (options.probeController.signal.aborted) throw new MediaMtxReadinessError('ABORTED');
    try {
      const snapshot = await options.client.listPaths(options.probeController.signal);
      if (options.probeController.signal.aborted) throw new MediaMtxReadinessError('ABORTED');
      if (hasExactPaths(snapshot, options.expectedPathNames)) {
        if (options.process.status().state === 'closed') {
          throw new MediaMtxReadinessError('PROCESS_EXITED');
        }
        return Object.freeze({
          itemCount: snapshot.itemCount,
          pageCount: snapshot.pageCount,
          items: Object.freeze(snapshot.items.map((path) => Object.freeze({ ...path }))),
        });
      }
    } catch (error) {
      if (!(error instanceof MediaMtxApiClientError)) throw new MediaMtxReadinessError('PROBE_FAILED');
      if (error.code !== 'REQUEST_FAILED' && error.code !== 'SERVER_ERROR') {
        throw mapClientError(error.code);
      }
    }
    await options.scheduler.wait(RETRY_INTERVAL_MS, options.probeController.signal);
  }
}

function assertExpectedPaths(paths: readonly string[]): void {
  if (paths.length !== REQUIRED_PATH_COUNT || new Set(paths).size !== REQUIRED_PATH_COUNT) {
    throw new MediaMtxReadinessError('CONFIG_INVALID');
  }
}

function hasExactPaths(snapshot: MediaMtxPathsSnapshot, expected: readonly string[]): boolean {
  if (
    snapshot.itemCount !== REQUIRED_PATH_COUNT
    || snapshot.pageCount !== 1
    || snapshot.items.length !== REQUIRED_PATH_COUNT
  ) return false;
  const actual = new Set(snapshot.items.map(({ name }) => name));
  return actual.size === REQUIRED_PATH_COUNT && expected.every((name) => actual.has(name));
}

function mapClientError(code: MediaMtxApiClientError['code']): MediaMtxReadinessError {
  switch (code) {
    case 'ABORTED': return new MediaMtxReadinessError('ABORTED');
    case 'AUTH_FAILED': return new MediaMtxReadinessError('AUTH_FAILED');
    case 'CONFIG_INVALID': return new MediaMtxReadinessError('CONFIG_INVALID');
    case 'CREDENTIAL_DISPOSED': return new MediaMtxReadinessError('CREDENTIAL_DISPOSED');
    case 'HTTP_ERROR': return new MediaMtxReadinessError('HTTP_ERROR');
    case 'MALFORMED_RESPONSE': return new MediaMtxReadinessError('MALFORMED_RESPONSE');
    case 'RESPONSE_TOO_LARGE': return new MediaMtxReadinessError('RESPONSE_TOO_LARGE');
    case 'REQUEST_FAILED':
    case 'SERVER_ERROR': return new MediaMtxReadinessError('PROBE_FAILED');
    default: return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected MediaMTX readiness variant: ${String(value)}`);
}
