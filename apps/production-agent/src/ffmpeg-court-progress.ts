import type { ClockPort } from './ffmpeg-court-pipeline-model.js';
import type { FfmpegCourtGeneration, GenerationFault } from './ffmpeg-court-generation.js';
import type { ProcessCloseStatus } from './managed-process.js';
import type { SchedulerPort } from './process-stop.js';

const FFMPEG_CLOSE_CORRELATION_MS = 100;

export type ProgressConsumerOptions = {
  readonly generation: FfmpegCourtGeneration;
  readonly source: AsyncIterable<Uint8Array>;
  readonly clock: ClockPort;
  readonly scheduler: SchedulerPort;
  readonly close: Promise<ProcessCloseStatus>;
  readonly changed: () => void;
  readonly failed: (fault: GenerationFault) => void;
};

type ProcessCloseCorrelation =
  | { readonly kind: 'closed'; readonly status: ProcessCloseStatus }
  | { readonly kind: 'closeFailed' }
  | { readonly kind: 'expired' };

export async function consumeFfmpegProgress(options: ProgressConsumerOptions): Promise<void> {
  const generation = options.generation;
  try {
    for await (const chunk of options.source) {
      for (const record of generation.parser.push(chunk)) {
        const nowMs = options.clock.nowMs();
        generation.health.observe(record, nowMs);
        const frameAdvanced = record.frame > generation.latestFrame;
        const timeAdvanced = record.outTimeUs !== null
          && (generation.latestOutTimeUs === null || record.outTimeUs > generation.latestOutTimeUs);
        generation.latestFrame = Math.max(generation.latestFrame, record.frame);
        if (timeAdvanced) generation.latestOutTimeUs = record.outTimeUs;
        if (frameAdvanced || timeAdvanced) {
          generation.progressReady = true;
          generation.lastProgressAdvanceMs = nowMs;
        }
        if (record.progress === 'end' && !generation.intentional) {
          options.failed('PROGRESS_FAILED');
        } else if (frameAdvanced || timeAdvanced) {
          options.changed();
        }
      }
    }
  } catch {
    finishParserAfterFailure(generation);
    if (!generation.intentional) options.failed('PROGRESS_FAILED');
    return;
  }
  const parserComplete = finishParser(generation);
  if (generation.intentional) return;
  const correlation = await correlateProcessClose(options.close, options.scheduler);
  switch (correlation.kind) {
    case 'closeFailed': options.failed('PROCESS_FAILED'); return;
    case 'expired': options.failed('PROGRESS_FAILED'); return;
    case 'closed':
      if (correlation.status.code !== 0 || correlation.status.signal !== null) options.failed('PROCESS_FAILED');
      else if (!parserComplete || !generation.parser.hasEnded()) options.failed('PROGRESS_FAILED');
      return;
    default: return assertNever(correlation);
  }
}

async function correlateProcessClose(
  close: Promise<ProcessCloseStatus>,
  scheduler: SchedulerPort,
): Promise<ProcessCloseCorrelation> {
  const controller = new AbortController();
  const result = await Promise.race([
    close.then(
      (status): ProcessCloseCorrelation => ({ kind: 'closed', status }),
      (): ProcessCloseCorrelation => ({ kind: 'closeFailed' }),
    ),
    scheduler.wait(FFMPEG_CLOSE_CORRELATION_MS, controller.signal)
      .then((): ProcessCloseCorrelation => ({ kind: 'expired' })),
  ]);
  controller.abort();
  return result;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected process close correlation: ${String(value)}`);
}

function finishParser(generation: FfmpegCourtGeneration): boolean {
  if (generation.parserFinished) return true;
  generation.parserFinished = true;
  try {
    generation.parser.finish();
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function finishParserAfterFailure(generation: FfmpegCourtGeneration): void {
  if (generation.parserFinished) return;
  generation.parserFinished = true;
  try {
    generation.parser.finish();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
}
