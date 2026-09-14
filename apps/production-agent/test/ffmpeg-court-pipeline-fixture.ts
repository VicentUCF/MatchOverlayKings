import { CourtIdSchema } from '@kpl/production-contracts';
import type { FfmpegCourtPipelineOptions, OverlayFrameSourceFactoryPort } from '../src/ffmpeg-court-pipeline-model.js';
import { ProcessAdapterError, type ManagedProcessPort, type ManagedProcessStatus, type ProcessCloseStatus, type ProcessDiagnostics, type ProcessSignal, type ProcessSignalResult, type ProcessSpawnerPort } from '../src/managed-process.js';
import {
  MediaMtxApiClientError,
  type MediaMtxApiClientErrorCode,
  type MediaMtxPathsSnapshot,
} from '../src/mediamtx-api-client.js';
import { OverlayInputDescriptorSchema } from '../src/media-runtime-config.js';
import { ProfileFingerprintSchema, ReconcileInputSchema, type PipelineTarget } from '../src/models.js';
import type { ProcessCommandPlan } from '../src/process-command-plan.js';
import type { SchedulerPort } from '../src/process-stop.js';
import { COURT_ID, reconcileInput } from './fixtures.js';
import { mediaConfig, PATHS } from './mediamtx-service-fixture.js';

const diagnostics: ProcessDiagnostics = {
  stdoutBytes: 0, stderrBytes: 0, warningChunks: 0, errorChunks: 0, streamErrors: 0,
  progressQueuedBytes: 0, progressQueuedItems: 0, progressDroppedBytes: 0,
  progressDroppedItems: 0, progressCoalescedItems: 0, fd4DrainListeners: 0,
  fd4ErrorListeners: 0, fd4CloseListeners: 0,
};

export type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
};

export function deferred<Value>(): Deferred<Value> {
  let resolveValue: (value: Value) => void = () => undefined;
  let rejectValue: (error: Error) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

export class ByteQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;
  public consumers = 0;

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.consumers += 1;
    return { next: () => this.next() };
  }

  public push(value: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }

  public end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }
}

export class ManualClockScheduler implements SchedulerPort {
  public now = 0;
  public readonly waits: Array<{ readonly delayMs: number; readonly signal: AbortSignal; readonly finish: () => void }> = [];
  private readonly settled = new Set<() => void>();
  public readonly nowMs = (): number => this.now;
  public readonly wait = (delayMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      this.settled.add(finish);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    this.waits.push({ delayMs, signal, finish });
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
  public advance(delayMs: number): void {
    const wait = this.waits.find((candidate) => candidate.delayMs === delayMs
      && !candidate.signal.aborted && !this.settled.has(candidate.finish));
    if (wait === undefined) throw new TypeError(`Missing active ${delayMs}ms wait`);
    this.now += delayMs;
    wait.finish();
  }
}

export class FakeInspector {
  public readonly signals: AbortSignal[] = [];
  private readonly responses: Array<() => Promise<MediaMtxPathsSnapshot>> = [];
  public enqueue(value: MediaMtxPathsSnapshot | Promise<MediaMtxPathsSnapshot>): void {
    this.responses.push(() => Promise.resolve(value));
  }
  public enqueueFailure(code: MediaMtxApiClientErrorCode = 'REQUEST_FAILED'): void {
    this.responses.push(() => Promise.reject(new MediaMtxApiClientError(code)));
  }
  public readonly inspectPaths = (signal: AbortSignal): Promise<MediaMtxPathsSnapshot> => {
    this.signals.push(signal);
    if (signal.aborted) return Promise.reject(new TestFailure());
    return this.responses.shift()?.() ?? Promise.resolve(snapshot(false));
  };
}

export class FakeProcess implements ManagedProcessPort {
  public readonly close: Promise<ProcessCloseStatus>;
  public readonly signals: ProcessSignal[] = [];
  public pumpCalls = 0;
  public releaseCalls = 0;
  public releaseFailures = 0;
  public failSignal: ProcessSignal | null = null;
  public closeOn: ProcessSignal | null = 'SIGTERM';
  public pumpResult: Promise<void> = new Promise(() => undefined);
  public pumpHonorsAbort = true;
  private closed: ProcessCloseStatus | null = null;
  private resolveClose: (status: ProcessCloseStatus) => void = () => undefined;
  public constructor(public readonly progress: AsyncIterable<Uint8Array> | null = new ByteQueue()) {
    this.close = new Promise((resolve) => { this.resolveClose = resolve; });
  }
  public readonly diagnostics = (): ProcessDiagnostics => diagnostics;
  public readonly pumpFd4 = (_chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> => {
    this.pumpCalls += 1;
    if (!this.pumpHonorsAbort) return this.pumpResult;
    return new Promise((resolve, reject) => {
      const abort = (): void => { reject(new ProcessAdapterError('ABORTED')); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      void this.pumpResult.then(
        () => { signal.removeEventListener('abort', abort); resolve(); },
        (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  };
  public readonly signal = (signal: ProcessSignal): ProcessSignalResult => {
    if (this.closed !== null) return { state: 'alreadyClosed' };
    this.signals.push(signal);
    if (signal === this.failSignal) return { state: 'failed' };
    if (signal === this.closeOn) this.finish({ code: null, signal });
    return { state: 'delivered' };
  };
  public readonly status = (): ManagedProcessStatus => this.closed === null
    ? { state: 'running' } : { state: 'closed', close: this.closed };
  public readonly releaseHandles = (): void => {
    this.releaseCalls += 1;
    if (this.releaseFailures > 0) { this.releaseFailures -= 1; throw new TestFailure(); }
  };
  public finish(status: ProcessCloseStatus = { code: 0, signal: null }): void {
    if (this.closed !== null) return;
    this.closed = status;
    if (this.progress instanceof ByteQueue) this.progress.end();
    this.resolveClose(status);
  }
}

type ActiveProcessTracker = {
  readonly activate: () => void;
  readonly deactivate: () => void;
};

export class FakeSpawner implements ProcessSpawnerPort {
  public readonly calls: ProcessCommandPlan[] = [];
  public barrier: Promise<void> | null = null;
  public constructor(
    public process: FakeProcess,
    private readonly tracker: ActiveProcessTracker | null = null,
  ) {}
  public readonly spawn = async (plan: ProcessCommandPlan): Promise<ManagedProcessPort> => {
    this.calls.push(plan);
    if (this.barrier !== null) await this.barrier;
    const process = this.process;
    this.tracker?.activate();
    if (this.tracker !== null) void process.close.then(() => { this.tracker?.deactivate(); });
    return process;
  };
}

export class TestFailure extends Error {}

export function snapshot(ready: boolean, names: readonly string[] = PATHS): MediaMtxPathsSnapshot {
  return Object.freeze({
    itemCount: names.length,
    pageCount: 1,
    items: Object.freeze(names.map((name) => Object.freeze({
      name, available: ready && name === PATHS[0], online: ready && name === PATHS[0],
    }))),
  });
}

export function progress(frame: number, marker: 'continue' | 'end' = 'continue', outTime = 'N/A'): Uint8Array {
  return new TextEncoder().encode(`frame=${frame}\nout_time_us=${outTime}\nfps=60\nspeed=1x\nunknown=ok\nprogress=${marker}\n`);
}

export function target(overlayEnabled = false): PipelineTarget {
  const input = reconcileInput();
  const parsed = ReconcileInputSchema.parse({
    ...input,
    desired: { ...input.desired, desired: { ...input.desired.desired, profile: {
      ...input.desired.desired.profile, audioSourceDeviceId: null, overlayEnabled,
    } } },
  });
  return { output: parsed.output, desired: parsed.desired, profileFingerprint: ProfileFingerprintSchema.parse('a'.repeat(64)) };
}

export function createContext(settings: {
  readonly overlay?: boolean;
  readonly healthTimeoutMs?: number;
  readonly progress?: boolean;
} = {}) {
  const bytes = new ByteQueue();
  const process = new FakeProcess(settings.progress === false ? null : bytes);
  const spawner = new FakeSpawner(process);
  const inspector = new FakeInspector();
  const scheduler = new ManualClockScheduler();
  const overlayFrames = new ByteQueue();
  const overlayFactory: OverlayFrameSourceFactoryPort = { create: () => ({
    descriptor: OverlayInputDescriptorSchema.parse({ fd: 4, pixelFormat: 'rgba', width: 1920, height: 1080, framesPerSecond: 60 }),
    frames: overlayFrames,
  }) };
  const baseConfig = mediaConfig();
  const options: FfmpegCourtPipelineOptions = {
    config: { ...baseConfig, healthTimeoutMs: settings.healthTimeoutMs ?? baseConfig.healthTimeoutMs },
    courtId: CourtIdSchema.parse(COURT_ID), spawner, scheduler, clock: scheduler,
    mediaInspector: inspector, overlayFactory: settings.overlay === true ? overlayFactory : null,
  };
  return { options, bytes, process, spawner, inspector, scheduler, overlayFrames };
}

export async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new TestFailure('Condition did not become true');
}

export async function flushMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

export async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  if (settled) throw new TestFailure('Expected promise to remain pending');
}
