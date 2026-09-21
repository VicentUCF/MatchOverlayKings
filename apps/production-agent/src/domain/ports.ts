import type { OutputId } from '@kpl/production-contracts';
import type { PipelineRuntime, PipelineTarget } from './models.js';

export interface CourtPipelinePort {
  readonly getRuntime: (
    outputId: OutputId,
    signal: AbortSignal,
  ) => Promise<PipelineRuntime | null>;
  readonly start: (target: PipelineTarget, signal: AbortSignal) => Promise<PipelineRuntime>;
  readonly stop: (runtime: PipelineRuntime, signal: AbortSignal) => Promise<void>;
}
