import { cancelGenerationWork, type FfmpegCourtGeneration } from './ffmpeg-court-generation.js';
import type { FfmpegCourtPipelineOptions } from './ffmpeg-court-pipeline-model.js';
import { stopFfmpeg } from './process-stop.js';

export class FfmpegFinalizationError extends Error {
  public constructor() {
    super('FFmpeg generation finalization failed');
    this.name = 'FfmpegFinalizationError';
  }
}

export function finalizeFfmpegGeneration(
  generation: FfmpegCourtGeneration,
  options: FfmpegCourtPipelineOptions,
  urgencySignal: AbortSignal,
): Promise<void> {
  if (generation.finalization !== null) {
    const detach = accelerateShutdown(generation, urgencySignal);
    void generation.finalization.then(detach, detach);
    return generation.finalization;
  }
  const detach = accelerateShutdown(generation, urgencySignal);
  const operation = performFinalization(generation, options);
  generation.finalization = operation;
  void operation.then(detach, detach);
  void operation.then(undefined, () => {
    if (generation.finalization === operation) generation.finalization = null;
  });
  return operation;
}

async function performFinalization(
  generation: FfmpegCourtGeneration,
  options: FfmpegCourtPipelineOptions,
): Promise<void> {
  cancelGenerationWork(generation);
  const process = generation.process;
  if (process === null) return;
  try {
    if (process.status().state === 'running') {
      const reapController = new AbortController();
      const stopped = stopFfmpeg({ process, scheduler: options.scheduler,
        graceMs: options.config.stopGraceMs, signal: generation.shutdownController.signal });
      const result = await Promise.race([
        stopped.then(() => 'closed' as const),
        options.scheduler.wait(options.config.stopGraceMs * 2, reapController.signal)
          .then(() => 'unresolved' as const),
      ]);
      reapController.abort();
      if (result === 'unresolved') throw new FfmpegFinalizationError();
    }
    await process.close;
    await settleOwnedWork(generation, options);
    if (!generation.releaseClaimed) {
      generation.releaseClaimed = true;
      process.releaseHandles();
    }
  } catch {
    throw new FfmpegFinalizationError();
  }
}

async function settleOwnedWork(
  generation: FfmpegCourtGeneration,
  options: FfmpegCourtPipelineOptions,
): Promise<void> {
  const operations = [
    generation.progressOperation,
    generation.overlayOperation,
    generation.monitorOperation,
  ].filter((operation): operation is Promise<void> => operation !== null);
  if (operations.length === 0) return;
  const controller = new AbortController();
  const settled = Promise.all(operations.map((operation) => operation.then(
    () => undefined,
    () => undefined,
  )));
  await Promise.race([
    settled,
    options.scheduler.wait(options.config.stopGraceMs, controller.signal),
  ]);
  controller.abort();
}

function accelerateShutdown(generation: FfmpegCourtGeneration, signal: AbortSignal): () => void {
  if (signal.aborted) {
    generation.shutdownController.abort();
    return () => undefined;
  }
  const abort = (): void => { generation.shutdownController.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  return () => { signal.removeEventListener('abort', abort); };
}
