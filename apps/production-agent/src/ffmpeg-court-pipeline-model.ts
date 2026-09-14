import type { CourtId } from '@kpl/production-contracts';
import type { MediaMtxPathsSnapshot } from './mediamtx-api-client.js';
import type {
  LocalMediaRuntimeConfig,
  OverlayInputDescriptor,
} from './media-runtime-config.js';
import type { ProcessSpawnerPort } from './managed-process.js';
import type { PipelineTarget } from './models.js';
import type { SchedulerPort } from './process-stop.js';

export interface ClockPort {
  readonly nowMs: () => number;
}

export interface MediaMtxPathInspectorPort {
  readonly inspectPaths: (signal: AbortSignal) => Promise<MediaMtxPathsSnapshot>;
}

export type OverlayFrameSource = {
  readonly descriptor: OverlayInputDescriptor;
  readonly frames: AsyncIterable<Uint8Array>;
};

export interface OverlayFrameSourceFactoryPort {
  readonly create: (target: PipelineTarget) => OverlayFrameSource | null;
}

export type FfmpegCourtPipelineOptions = {
  readonly config: LocalMediaRuntimeConfig;
  readonly courtId: CourtId;
  readonly spawner: ProcessSpawnerPort;
  readonly scheduler: SchedulerPort;
  readonly clock: ClockPort;
  readonly mediaInspector: MediaMtxPathInspectorPort;
  readonly overlayFactory: OverlayFrameSourceFactoryPort | null;
};

export const FFMPEG_COURT_PIPELINE_LIFECYCLES = [
  'idle', 'starting', 'running', 'stopping', 'cleanupPending',
] as const;

export type FfmpegCourtPipelineLifecycle = (typeof FFMPEG_COURT_PIPELINE_LIFECYCLES)[number];

export type FfmpegCourtPipelineErrorCode =
  | 'CLEANUP_PENDING'
  | 'INSPECTION_BLOCKED'
  | 'INVALID_BINDING'
  | 'INVALID_TARGET'
  | 'MEDIA_FAILED'
  | 'OVERLAY_FAILED'
  | 'OVERLAY_UNAVAILABLE'
  | 'PROCESS_FAILED'
  | 'PROGRESS_FAILED'
  | 'RUNTIME_MISMATCH'
  | 'START_ABORTED'
  | 'START_BLOCKED'
  | 'START_TIMEOUT'
  | 'STOP_FAILED';

const errorMessages = {
  CLEANUP_PENDING: 'FFmpeg pipeline cleanup remains pending',
  INSPECTION_BLOCKED: 'FFmpeg pipeline inspection is blocked',
  INVALID_BINDING: 'FFmpeg pipeline media binding is invalid',
  INVALID_TARGET: 'FFmpeg pipeline target is invalid',
  MEDIA_FAILED: 'FFmpeg pipeline media failed',
  OVERLAY_FAILED: 'FFmpeg pipeline overlay failed',
  OVERLAY_UNAVAILABLE: 'FFmpeg pipeline overlay is unavailable',
  PROCESS_FAILED: 'FFmpeg pipeline process failed',
  PROGRESS_FAILED: 'FFmpeg pipeline progress failed',
  RUNTIME_MISMATCH: 'FFmpeg pipeline runtime does not match target',
  START_ABORTED: 'FFmpeg pipeline start was aborted',
  START_BLOCKED: 'FFmpeg pipeline start is blocked',
  START_TIMEOUT: 'FFmpeg pipeline start timed out',
  STOP_FAILED: 'FFmpeg pipeline stop failed',
} as const satisfies Record<FfmpegCourtPipelineErrorCode, string>;

export class FfmpegCourtPipelineError extends Error {
  public constructor(public readonly code: FfmpegCourtPipelineErrorCode) {
    super(errorMessages[code]);
    this.name = 'FfmpegCourtPipelineError';
  }
}
