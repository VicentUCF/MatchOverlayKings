import type { LocalMediaRuntimeConfig } from '../src/media-runtime-config.js';
import { LocalMediaRuntimeConfigSchema } from '../src/media-runtime-config.js';
import type {
  MediaMtxApiClientError,
  MediaMtxApiClientPort,
  MediaMtxPathsSnapshot,
} from '../src/mediamtx-api-client.js';
import type { MediaMtxApiCredentials } from '../src/mediamtx-api-credentials.js';
import type { EphemeralRuntimeArtifact, EphemeralRuntimeFilesPort } from '../src/ephemeral-runtime-files.js';
import type {
  ManagedProcessPort,
  ManagedProcessStatus,
  ProcessCloseStatus,
  ProcessDiagnostics,
  ProcessSignal,
  ProcessSignalResult,
  ProcessSpawnerPort,
} from '../src/managed-process.js';
import type { ProcessCommandPlan } from '../src/process-command-plan.js';
import type { SchedulerPort } from '../src/process-stop.js';

export const PATHS = ['court-1', 'court-2', 'court-3', 'court-4'] as const;
const COURT_IDS = [
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004',
] as const;

const VIDEO_DEVICE_IDS = ['50000000-0000-4000-8000-000000000001'] as const;

export function mediaConfig(
  courtIds: readonly string[] = COURT_IDS,
  videoDeviceIds: readonly string[] = VIDEO_DEVICE_IDS,
): LocalMediaRuntimeConfig {
  return LocalMediaRuntimeConfigSchema.parse({
    courtIds,
    mediaMtxVersion: '1.21.0',
    mediaMtxExecutablePath: '/opt/kpl/bin/mediamtx',
    ffmpegExecutablePath: '/opt/kpl/bin/ffmpeg',
    runtimeDirectoryPath: '/run/user/1000/kpl-agent',
    runtimeDirectoryMode: 0o700,
    configFileMode: 0o600,
    persistence: 'ephemeral',
    startupTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    stopGraceMs: 2_000,
    bindings: {
      apiHost: '127.0.0.1', apiPort: 9997, srtHost: '127.0.0.1', srtPort: 8890,
      courts: courtIds.map((courtId, index) => ({ courtId, pathName: PATHS[index] })),
      videoInputs: videoDeviceIds.map((deviceId, index) => ({
        deviceId, kind: 'v4l2', devicePath: `/dev/video${index}`, inputPixelFormat: 'yuyv422',
      })),
      audioInputs: [],
    },
  });
}

export const statuses = (names: readonly string[] = PATHS) => Object.freeze(names.map(
  (name, index) => Object.freeze({ name, available: index % 2 === 0, online: false }),
));

export const snapshot = (
  names: readonly string[] = PATHS,
  itemCount = names.length,
  pageCount = 1,
): MediaMtxPathsSnapshot => Object.freeze({ itemCount, pageCount, items: statuses(names) });

export function itemAt<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) throw new TypeError(`Missing fixture item at index ${index}`);
  return item;
}

type Wait = { readonly delayMs: number; readonly signal: AbortSignal; readonly resolve: () => void };

export class ManualScheduler implements SchedulerPort {
  public readonly waits: Wait[] = [];
  public wait = (delayMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    this.waits.push({ delayMs, signal, resolve: finish });
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
  public advance(delayMs: number): void {
    const wait = this.waits.find((candidate) => candidate.delayMs === delayMs && !candidate.signal.aborted);
    if (wait === undefined) throw new TypeError(`Missing ${delayMs} ms wait`);
    wait.resolve();
  }
  public count(delayMs: number): number {
    return this.waits.filter((wait) => wait.delayMs === delayMs).length;
  }
}

const diagnostics: ProcessDiagnostics = {
  stdoutBytes: 0, stderrBytes: 0, warningChunks: 0, errorChunks: 0, streamErrors: 0,
  progressQueuedBytes: 0, progressQueuedItems: 0, progressDroppedBytes: 0,
  progressDroppedItems: 0, progressCoalescedItems: 0,
  fd4DrainListeners: 0, fd4ErrorListeners: 0, fd4CloseListeners: 0,
};

export class FakeProcess implements ManagedProcessPort {
  public readonly progress = null;
  public readonly close: Promise<ProcessCloseStatus>;
  public readonly signals: ProcessSignal[] = [];
  public releaseCalls = 0;
  public releaseFailures = 0;
  public closeOn: ProcessSignal | null = 'SIGINT';
  public failOn: ProcessSignal | null = null;
  private closed: ProcessCloseStatus | null = null;
  private resolveClose: (status: ProcessCloseStatus) => void = () => undefined;
  public constructor() {
    this.close = new Promise((resolve) => { this.resolveClose = resolve; });
  }
  public diagnostics = (): ProcessDiagnostics => diagnostics;
  public pumpFd4 = async (): Promise<void> => undefined;
  public signal = (signal: ProcessSignal): ProcessSignalResult => {
    if (this.closed !== null) return { state: 'alreadyClosed' };
    this.signals.push(signal);
    if (signal === this.failOn) return { state: 'failed' };
    if (signal === this.closeOn) this.finish({ code: null, signal });
    return { state: 'delivered' };
  };
  public status = (): ManagedProcessStatus => this.closed === null
    ? { state: 'running' }
    : { state: 'closed', close: this.closed };
  public releaseHandles = (): void => {
    this.releaseCalls += 1;
    if (this.releaseFailures > 0) {
      this.releaseFailures -= 1;
      throw new Error('private release failure');
    }
  };
  public finish(status: ProcessCloseStatus = { code: 0, signal: null }): void {
    if (this.closed !== null) return;
    this.closed = status;
    this.resolveClose(status);
  }
}

export class FakeSpawner implements ProcessSpawnerPort {
  public calls: ProcessCommandPlan[] = [];
  public failure: Error | null = null;
  public block: Promise<void> | null = null;
  public constructor(public readonly process: FakeProcess) {}
  public spawn = async (plan: ProcessCommandPlan): Promise<ManagedProcessPort> => {
    this.calls.push(plan);
    if (this.block !== null) await this.block;
    if (this.failure !== null) throw this.failure;
    return this.process;
  };
}

export class FakeCredential implements MediaMtxApiCredentials {
  public disposeCalls = 0;
  public disposeFailures = 0;
  public planner = () => ({ username: 'api-user', passwordHash: `sha256:${'A'.repeat(43)}=` });
  public withBasicAuthorization = async <Result>(consumer: (value: string) => Result | Promise<Result>) => (
    consumer('Basic SECRET_HEADER_SENTINEL')
  );
  public dispose = (): void => {
    this.disposeCalls += 1;
    if (this.disposeFailures > 0) {
      this.disposeFailures -= 1;
      throw new Error('private disposal failure');
    }
  };
  public toJSON = (): string => '[REDACTED]';
  public toString = (): string => '[REDACTED]';
}

export type ClientOutcome = MediaMtxPathsSnapshot | MediaMtxApiClientError | Promise<MediaMtxPathsSnapshot>;

export class FakeApiClient implements MediaMtxApiClientPort {
  public calls = 0;
  public readonly signals: AbortSignal[] = [];
  public constructor(public outcomes: ClientOutcome[] = [snapshot()]) {}
  public listPaths = async (signal: AbortSignal) => {
    this.calls += 1;
    this.signals.push(signal);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new TypeError('Missing API outcome');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

export class FakeArtifact implements EphemeralRuntimeArtifact {
  public readonly configPath = '/run/user/1000/kpl-agent/owned/mediamtx.yml';
  public cleanupCalls = 0;
  public recoveryCalls = 0;
  public cleanupFailures = 0;
  public recoveryFailures = 0;
  public cleanup = async (): Promise<void> => {
    this.cleanupCalls += 1;
    if (this.cleanupFailures === 0) return;
    this.cleanupFailures -= 1;
    throw Object.assign(new Error('private cleanup detail'), {
      code: 'CLEANUP_FAILED' as const,
      retryCleanup: async (): Promise<void> => {
        this.recoveryCalls += 1;
        if (this.recoveryFailures > 0) {
          this.recoveryFailures -= 1;
          throw new Error('private recovery failure');
        }
      },
    });
  };
}

export class FakeRuntimeFiles implements EphemeralRuntimeFilesPort {
  public calls = 0;
  public failure: Error | null = null;
  public block: Promise<void> | null = null;
  public constructor(public readonly artifact: FakeArtifact) {}
  public create = async (): Promise<EphemeralRuntimeArtifact> => {
    this.calls += 1;
    if (this.block !== null) await this.block;
    if (this.failure !== null) throw this.failure;
    return this.artifact;
  };
}

export async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new TypeError('Condition did not become true');
}

export async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  if (settled) throw new TypeError('Expected promise to remain pending');
}
