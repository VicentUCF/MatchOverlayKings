import { describe, expect, it } from 'vitest';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import type { PipelineRuntime } from '../src/models.js';
import {
  createContext,
  flushUntil,
  progress,
  snapshot,
  target,
} from './ffmpeg-court-pipeline-fixture.js';

type ActiveRecovery = {
  readonly context: ReturnType<typeof createContext>;
  readonly pipeline: FfmpegCourtPipeline;
  readonly runtime: PipelineRuntime;
};

async function startActiveRecovery(): Promise<ActiveRecovery> {
  const context = createContext();
  context.inspector.enqueue(snapshot(false));
  context.inspector.enqueue(snapshot(true));
  context.process.closeOn = null;
  const pipeline = new FfmpegCourtPipeline(context.options);
  const started = pipeline.start(target(), new AbortController().signal);
  context.bytes.push(progress(1));
  const runtime = await started;
  const stopped = pipeline.stop(runtime, new AbortController().signal);
  await flushUntil(() => context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 2_000 && !signal.aborted));
  context.scheduler.advance(2_000);
  await flushUntil(() => context.process.signals.includes('SIGKILL'));
  context.scheduler.advance(4_000);
  await expect(stopped).rejects.toMatchObject({ code: 'STOP_FAILED' });
  await flushUntil(() => context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 100 && !signal.aborted));
  context.scheduler.advance(100);
  await flushUntil(() => context.process.signals.length === 3);
  return { context, pipeline, runtime };
}

describe('FFmpeg court finalization ownership races', () => {
  it('coalesces user stop with an active autonomous recovery attempt', async () => {
    // Given
    const fixture = await startActiveRecovery();
    const signalsBeforeStop = fixture.context.process.signals.length;

    // When
    const stopped = fixture.pipeline.stop(fixture.runtime, new AbortController().signal);

    // Then
    expect(fixture.context.process.signals).toHaveLength(signalsBeforeStop);
    fixture.context.process.finish();
    await expect(stopped).resolves.toBeUndefined();
    expect(fixture.context.process.releaseCalls).toBe(1);
  });

  it('coalesces process close with an active autonomous recovery attempt', async () => {
    // Given
    const fixture = await startActiveRecovery();

    // When
    fixture.context.process.finish({ code: null, signal: 'SIGKILL' });
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    const activeOwnedWorkBounds = fixture.context.scheduler.waits.filter(({ delayMs, signal }) => (
      delayMs === 2_000 && !signal.aborted
    ));
    expect(activeOwnedWorkBounds).toHaveLength(0);
    expect(fixture.context.process.releaseCalls).toBe(1);
  });
});
