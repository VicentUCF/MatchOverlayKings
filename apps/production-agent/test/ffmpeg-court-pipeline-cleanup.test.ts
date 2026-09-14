import { describe, expect, it } from 'vitest';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import { createContext, flushUntil, progress, snapshot, target } from './ffmpeg-court-pipeline-fixture.js';

describe('FFmpeg court pipeline unresolved reaping recovery', () => {
  it('blocks starts until a process that ignored SIGKILL later closes', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    context.process.closeOn = null;
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), new AbortController().signal);
    context.bytes.push(progress(1));
    const runtime = await started;

    // When
    const stopped = pipeline.stop(runtime, new AbortController().signal);
    await flushUntil(() => context.scheduler.waits.some(({ delayMs }) => delayMs === 2_000));
    context.scheduler.advance(2_000);
    await flushUntil(() => context.process.signals.includes('SIGKILL'));
    context.scheduler.advance(4_000);

    // Then
    await expect(stopped).rejects.toMatchObject({ code: 'STOP_FAILED' });
    await expect(pipeline.start(target(), new AbortController().signal)).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    context.process.finish({ code: null, signal: 'SIGKILL' });
    await flushUntil(() => context.process.releaseCalls === 1);
    await expect(pipeline.getRuntime(runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });
});
