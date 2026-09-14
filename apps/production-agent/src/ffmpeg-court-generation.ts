import { FfmpegHealthTracker } from './ffmpeg-health.js';
import { FfmpegProgressParser } from './ffmpeg-progress.js';
import type { ManagedProcessPort } from './managed-process.js';
import type { PipelineRuntime, PipelineTarget } from './models.js';
import type { ResolvedFfmpegCourtPlan } from './ffmpeg-court-plan.js';
import type { FfmpegCourtPipelineErrorCode } from './ffmpeg-court-pipeline-model.js';

export type GenerationFault = Extract<
  FfmpegCourtPipelineErrorCode,
  'MEDIA_FAILED' | 'OVERLAY_FAILED' | 'PROCESS_FAILED' | 'PROGRESS_FAILED'
>;

export type FfmpegCourtGeneration = {
  readonly target: PipelineTarget;
  readonly runtime: PipelineRuntime;
  plan: ResolvedFfmpegCourtPlan | null;
  process: ManagedProcessPort | null;
  readonly parser: FfmpegProgressParser;
  readonly health: FfmpegHealthTracker;
  readonly startupController: AbortController;
  readonly monitorController: AbortController;
  readonly overlayController: AbortController;
  readonly shutdownController: AbortController;
  readonly ready: Promise<void>;
  resolveReady: () => void;
  readonly failed: Promise<GenerationFault>;
  resolveFailed: (fault: GenerationFault) => void;
  fault: GenerationFault | null;
  intentional: boolean;
  progressReady: boolean;
  mediaReady: boolean;
  latestFrame: number;
  latestOutTimeUs: number | null;
  lastProgressAdvanceMs: number | null;
  lastMediaSuccessMs: number | null;
  parserFinished: boolean;
  progressOperation: Promise<void> | null;
  overlayOperation: Promise<void> | null;
  monitorOperation: Promise<void> | null;
  finalization: Promise<void> | null;
  recoveryOperation: Promise<void> | null;
  lateSpawnPending: boolean;
  releaseClaimed: boolean;
};

export function createFfmpegCourtGeneration(
  target: PipelineTarget,
  runtime: PipelineRuntime,
  healthTimeoutMs: number,
): FfmpegCourtGeneration {
  let resolveReady = (): void => undefined;
  let resolveFailed: (fault: GenerationFault) => void = () => undefined;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const failed = new Promise<GenerationFault>((resolve) => { resolveFailed = resolve; });
  return {
    target,
    runtime,
    plan: null,
    process: null,
    parser: new FfmpegProgressParser(),
    health: new FfmpegHealthTracker(healthTimeoutMs),
    startupController: new AbortController(),
    monitorController: new AbortController(),
    overlayController: new AbortController(),
    shutdownController: new AbortController(),
    ready,
    resolveReady,
    failed,
    resolveFailed,
    fault: null,
    intentional: false,
    progressReady: false,
    mediaReady: false,
    latestFrame: 0,
    latestOutTimeUs: null,
    lastProgressAdvanceMs: null,
    lastMediaSuccessMs: null,
    parserFinished: false,
    progressOperation: null,
    overlayOperation: null,
    monitorOperation: null,
    finalization: null,
    recoveryOperation: null,
    lateSpawnPending: false,
    releaseClaimed: false,
  };
}

export function targetsMatch(left: PipelineTarget, right: PipelineTarget): boolean {
  return left.output.id === right.output.id
    && left.desired.version === right.desired.version
    && left.profileFingerprint === right.profileFingerprint;
}

export function recordGenerationFault(
  generation: FfmpegCourtGeneration,
  fault: GenerationFault,
): boolean {
  if (generation.fault !== null || generation.intentional) return false;
  generation.fault = fault;
  generation.resolveFailed(fault);
  return true;
}

export function cancelGenerationWork(generation: FfmpegCourtGeneration): void {
  generation.startupController.abort();
  generation.monitorController.abort();
  generation.overlayController.abort();
}
