import { MediaMtxApiClientError, type MediaMtxPathsSnapshot } from './mediamtx-api-client.js';
import type { FfmpegCourtGeneration, GenerationFault } from './ffmpeg-court-generation.js';
import type { FfmpegCourtPipelineOptions } from './ffmpeg-court-pipeline-model.js';

export const FFMPEG_MONITOR_INTERVAL_MS = 100;

type MonitorOptions = {
  readonly generation: FfmpegCourtGeneration;
  readonly pipeline: FfmpegCourtPipelineOptions;
  readonly changed: () => void;
  readonly failed: (fault: GenerationFault) => void;
};

type InspectionAttempt =
  | { readonly kind: 'snapshot'; readonly snapshot: MediaMtxPathsSnapshot }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'expired'; readonly fault: Extract<GenerationFault, 'MEDIA_FAILED' | 'PROGRESS_FAILED'> }
  | { readonly kind: 'cancelled' };

type InspectionDeadline =
  | { readonly kind: 'expired'; readonly fault: Extract<GenerationFault, 'MEDIA_FAILED' | 'PROGRESS_FAILED'> }
  | { readonly kind: 'cancelled' };

type HealthDeadline = {
  readonly fault: Extract<GenerationFault, 'MEDIA_FAILED' | 'PROGRESS_FAILED'>;
  readonly remainingMs: number;
};

export function isExactMediaSnapshot(
  snapshot: MediaMtxPathsSnapshot,
  expectedPathNames: readonly string[],
): boolean {
  if (snapshot.itemCount !== expectedPathNames.length || snapshot.pageCount !== 1
    || snapshot.items.length !== expectedPathNames.length) return false;
  const actual = new Set(snapshot.items.map(({ name }) => name));
  return actual.size === expectedPathNames.length
    && expectedPathNames.every((pathName) => actual.has(pathName));
}

export async function inspectFfmpegPreflight(
  generation: FfmpegCourtGeneration,
  options: FfmpegCourtPipelineOptions,
): Promise<void> {
  let snapshot: MediaMtxPathsSnapshot;
  try {
    snapshot = await options.mediaInspector.inspectPaths(generation.startupController.signal);
  } catch {
    throw new MediaInspectionFailure();
  }
  const expected = options.config.bindings.courts.map(({ pathName }) => pathName);
  if (!isExactMediaSnapshot(snapshot, expected)) throw new MediaInspectionFailure();
  const pathName = generation.plan?.pathName;
  if (pathName === undefined || !snapshot.items.some(({ name }) => name === pathName)) {
    throw new MediaInspectionFailure();
  }
  generation.lastMediaSuccessMs = options.clock.nowMs();
}

export async function monitorFfmpegGeneration(options: MonitorOptions): Promise<void> {
  const generation = options.generation;
  const expected = options.pipeline.config.bindings.courts.map(({ pathName }) => pathName);
  while (!generation.monitorController.signal.aborted) {
    inspectProgressHealth(options);
    if (generation.fault !== null) return;
    await inspectOnce(options, expected);
    if (generation.monitorController.signal.aborted || generation.fault !== null) return;
    inspectProgressHealth(options);
    if (generation.fault !== null) return;
    await options.pipeline.scheduler.wait(FFMPEG_MONITOR_INTERVAL_MS, generation.monitorController.signal);
  }
}

async function inspectOnce(options: MonitorOptions, expected: readonly string[]): Promise<void> {
  const generation = options.generation;
  const attempt = await inspectWithinBudget(options);
  switch (attempt.kind) {
    case 'cancelled': return;
    case 'expired': options.failed(attempt.fault); return;
    case 'failed': {
      const lastSuccess = generation.lastMediaSuccessMs;
      if (!isRetryableInspectionFailure(attempt.error) || lastSuccess === null
        || options.pipeline.clock.nowMs() - lastSuccess >= options.pipeline.config.healthTimeoutMs) {
        options.failed('MEDIA_FAILED');
      }
      return;
    }
    case 'snapshot': {
      const nowMs = options.pipeline.clock.nowMs();
      if (!isExactMediaSnapshot(attempt.snapshot, expected)) {
        options.failed('MEDIA_FAILED');
        return;
      }
      generation.lastMediaSuccessMs = nowMs;
      const pathName = generation.plan?.pathName;
      const path = attempt.snapshot.items.find(({ name }) => name === pathName);
      if (path === undefined || (!path.available || !path.online) && generation.mediaReady) {
        options.failed('MEDIA_FAILED');
        return;
      }
      if (path.available && path.online) {
        generation.mediaReady = true;
        options.changed();
      }
      return;
    }
    default: return assertNever(attempt);
  }
}

async function inspectWithinBudget(options: MonitorOptions): Promise<InspectionAttempt> {
  const generation = options.generation;
  const lastSuccess = generation.lastMediaSuccessMs;
  if (lastSuccess === null) return { kind: 'expired', fault: 'MEDIA_FAILED' };
  const requestController = new AbortController();
  const timerController = new AbortController();
  const cancelRequest = (): void => { requestController.abort(); };
  generation.monitorController.signal.addEventListener('abort', cancelRequest, { once: true });
  const inspection = options.pipeline.mediaInspector.inspectPaths(requestController.signal).then(
    (snapshot): InspectionAttempt => ({ kind: 'snapshot', snapshot }),
    (error: unknown): InspectionAttempt => ({ kind: 'failed', error }),
  );
  const deadline = waitForHealthDeadline(options, lastSuccess, timerController.signal);
  const result = await Promise.race([inspection, deadline]);
  const attempt: InspectionAttempt = generation.monitorController.signal.aborted ? { kind: 'cancelled' } : result;
  timerController.abort();
  if (attempt.kind === 'expired') requestController.abort();
  generation.monitorController.signal.removeEventListener('abort', cancelRequest);
  return attempt;
}

async function waitForHealthDeadline(
  options: MonitorOptions,
  lastMediaSuccessMs: number,
  signal: AbortSignal,
): Promise<InspectionDeadline> {
  while (!signal.aborted) {
    const deadline = earliestHealthDeadline(options, lastMediaSuccessMs);
    await options.pipeline.scheduler.wait(deadline.remainingMs, signal);
    if (signal.aborted) return { kind: 'cancelled' };
    const refreshed = earliestHealthDeadline(options, lastMediaSuccessMs);
    if (refreshed.remainingMs === 0) return { kind: 'expired', fault: refreshed.fault };
  }
  return { kind: 'cancelled' };
}

function earliestHealthDeadline(options: MonitorOptions, lastMediaSuccessMs: number): HealthDeadline {
  const nowMs = options.pipeline.clock.nowMs();
  const timeoutMs = options.pipeline.config.healthTimeoutMs;
  const mediaRemainingMs = Math.max(0, timeoutMs - (nowMs - lastMediaSuccessMs));
  const lastProgressAdvanceMs = options.generation.lastProgressAdvanceMs;
  if (lastProgressAdvanceMs === null) return { fault: 'MEDIA_FAILED', remainingMs: mediaRemainingMs };
  const progressRemainingMs = Math.max(0, timeoutMs - (nowMs - lastProgressAdvanceMs));
  return progressRemainingMs < mediaRemainingMs
    ? { fault: 'PROGRESS_FAILED', remainingMs: progressRemainingMs }
    : { fault: 'MEDIA_FAILED', remainingMs: mediaRemainingMs };
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected inspection attempt: ${String(value)}`);
}

function inspectProgressHealth(options: MonitorOptions): void {
  const lastAdvance = options.generation.lastProgressAdvanceMs;
  if (lastAdvance !== null
    && options.pipeline.clock.nowMs() - lastAdvance >= options.pipeline.config.healthTimeoutMs) {
    options.failed('PROGRESS_FAILED');
  }
}

function isRetryableInspectionFailure(error: unknown): boolean {
  return error instanceof MediaMtxApiClientError
    && (error.code === 'REQUEST_FAILED' || error.code === 'SERVER_ERROR');
}

export class MediaInspectionFailure extends Error {
  public constructor() {
    super('Media inspection failed');
    this.name = 'MediaInspectionFailure';
  }
}
