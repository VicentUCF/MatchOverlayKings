import type { FfmpegCourtGeneration, GenerationFault } from './ffmpeg-court-generation.js';
import { monitorFfmpegGeneration } from './ffmpeg-court-monitor.js';
import type { FfmpegCourtPipelineOptions } from './ffmpeg-court-pipeline-model.js';
import { consumeFfmpegProgress } from './ffmpeg-court-progress.js';
import { ProcessAdapterError } from './managed-process.js';

export type BackgroundCallbacks = {
  readonly changed: () => void;
  readonly failed: (fault: GenerationFault) => void;
  readonly closed: () => void;
};

export function startFfmpegBackground(
  generation: FfmpegCourtGeneration,
  options: FfmpegCourtPipelineOptions,
  callbacks: BackgroundCallbacks,
): void {
  const process = generation.process;
  if (process === null) {
    callbacks.failed('PROCESS_FAILED');
    return;
  }
  void process.close.then(callbacks.closed, callbacks.closed);
  if (process.progress === null) {
    callbacks.failed('PROGRESS_FAILED');
    return;
  }
  generation.progressOperation = consumeFfmpegProgress({
    generation,
    source: process.progress,
    clock: options.clock,
    scheduler: options.scheduler,
    close: process.close,
    changed: callbacks.changed,
    failed: callbacks.failed,
  });
  handleFailure(generation.progressOperation, () => callbacks.failed('PROGRESS_FAILED'));
  const overlayFrames = generation.plan?.overlayFrames;
  if (overlayFrames !== null && overlayFrames !== undefined) {
    generation.overlayOperation = process.pumpFd4(overlayFrames, generation.overlayController.signal);
    void generation.overlayOperation.then(
      () => {
        if (!generation.intentional && process.status().state === 'running') {
          callbacks.failed('OVERLAY_FAILED');
        }
      },
      (error: unknown) => {
        if (generation.intentional && error instanceof ProcessAdapterError
          && (error.code === 'ABORTED' || error.code === 'FD4_CLOSED')) return;
        if (!generation.intentional) callbacks.failed('OVERLAY_FAILED');
      },
    );
  }
  generation.monitorOperation = monitorFfmpegGeneration({
    generation,
    pipeline: options,
    changed: callbacks.changed,
    failed: callbacks.failed,
  });
  handleFailure(generation.monitorOperation, () => callbacks.failed('MEDIA_FAILED'));
}

function handleFailure(operation: Promise<void>, failed: () => void): void {
  void operation.then(() => undefined, failed);
}
