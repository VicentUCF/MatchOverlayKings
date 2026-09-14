import type { FfmpegCourtGeneration } from './ffmpeg-court-generation.js';
import {
  FfmpegCourtPipelineError,
  type FfmpegCourtPipelineLifecycle,
} from './ffmpeg-court-pipeline-model.js';
import type { PipelineRuntime } from './models.js';

export function projectFfmpegCourtRuntime(
  state: FfmpegCourtPipelineLifecycle,
  generation: FfmpegCourtGeneration | null,
  signal: AbortSignal,
): Promise<PipelineRuntime | null> {
  if (signal.aborted) return Promise.reject(new FfmpegCourtPipelineError('INSPECTION_BLOCKED'));
  switch (state) {
    case 'idle': return Promise.resolve(null);
    case 'running': {
      if (generation === null || generation.fault !== null || generation.intentional
        || generation.process?.status().state !== 'running') {
        return Promise.reject(new FfmpegCourtPipelineError('INSPECTION_BLOCKED'));
      }
      return Promise.resolve(generation.runtime);
    }
    case 'starting':
    case 'stopping':
    case 'cleanupPending': return Promise.reject(new FfmpegCourtPipelineError('INSPECTION_BLOCKED'));
    default: return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected FFmpeg court lifecycle: ${String(value)}`);
}
