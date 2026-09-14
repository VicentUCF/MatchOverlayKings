import { describe, expect, it } from 'vitest';
import { createFfmpegCourtGeneration } from '../src/ffmpeg-court-generation.js';
import { consumeFfmpegProgress } from '../src/ffmpeg-court-progress.js';
import type { ProcessCloseStatus } from '../src/managed-process.js';
import { PipelineRuntimeSchema } from '../src/models.js';
import {
  ByteQueue,
  createContext,
  deferred,
  flushUntil,
  progress,
  target,
} from './ffmpeg-court-pipeline-fixture.js';

describe('FFmpeg court progress close correlation', () => {
  it('maps an expired close correlation to progress failure', async () => {
    // Given
    const context = createContext();
    const pipelineTarget = target();
    const runtime = PipelineRuntimeSchema.parse({
      outputId: pipelineTarget.output.id,
      appliedDesiredVersion: pipelineTarget.desired.version,
      profileFingerprint: pipelineTarget.profileFingerprint,
    });
    const generation = createFfmpegCourtGeneration(pipelineTarget, runtime, context.options.config.healthTimeoutMs);
    const source = new ByteQueue();
    const close = deferred<ProcessCloseStatus>();
    const faults: string[] = [];
    const consumed = consumeFfmpegProgress({
      generation,
      source,
      clock: context.scheduler,
      scheduler: context.scheduler,
      close: close.promise,
      changed: () => undefined,
      failed: (fault) => { faults.push(fault); },
    });
    source.push(progress(1));
    source.end();
    await flushUntil(() => context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 100 && !signal.aborted));

    // When
    context.scheduler.advance(100);
    await consumed;
    close.resolve({ code: 0, signal: null });

    // Then
    expect(faults).toEqual(['PROGRESS_FAILED']);
  });

  it('maps a rejected process close to process failure', async () => {
    // Given
    const context = createContext();
    const pipelineTarget = target();
    const runtime = PipelineRuntimeSchema.parse({
      outputId: pipelineTarget.output.id,
      appliedDesiredVersion: pipelineTarget.desired.version,
      profileFingerprint: pipelineTarget.profileFingerprint,
    });
    const generation = createFfmpegCourtGeneration(pipelineTarget, runtime, context.options.config.healthTimeoutMs);
    const source = new ByteQueue();
    const close = deferred<ProcessCloseStatus>();
    const faults: string[] = [];
    const consumed = consumeFfmpegProgress({
      generation,
      source,
      clock: context.scheduler,
      scheduler: context.scheduler,
      close: close.promise,
      changed: () => undefined,
      failed: (fault) => { faults.push(fault); },
    });
    source.push(progress(1));
    source.end();
    await flushUntil(() => context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 100 && !signal.aborted));

    // When
    close.reject(new TypeError('private close failure'));
    await consumed;

    // Then
    expect(faults).toEqual(['PROCESS_FAILED']);
  });
});
