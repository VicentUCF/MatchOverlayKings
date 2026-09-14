import { describe, expect, it } from 'vitest';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import { ProfileFingerprintSchema } from '../src/models.js';
import { createContext, deferred, expectPending, flushUntil, progress, snapshot, target } from './ffmpeg-court-pipeline-fixture.js';

describe('FFmpeg court pipeline startup', () => {
  it.each(['progress-first', 'media-first'] as const)('opens the dual gate when %s', async (order) => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    if (order === 'progress-first') context.bytes.push(progress(1));
    const started = pipeline.start(target(), new AbortController().signal);
    await flushUntil(() => context.inspector.signals.length === 2);
    if (order === 'media-first') {
      await expectPending(started);
      context.bytes.push(progress(1));
    }

    // Then
    await expect(started).resolves.toMatchObject({ appliedDesiredVersion: 3 });
    expect(context.spawner.calls).toHaveLength(1);
    await pipeline.stop(await started, new AbortController().signal);
  });

  it('coalesces one compatible start and blocks another target', async () => {
    // Given
    const context = createContext();
    const gate = deferred<void>();
    const controller = new AbortController();
    context.inspector.enqueue(gate.promise.then(() => snapshot(false)));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const configured = target();

    // When
    const first = pipeline.start(configured, controller.signal);
    const same = pipeline.start(configured, controller.signal);
    const other = pipeline.start({
      ...configured,
      profileFingerprint: ProfileFingerprintSchema.parse('b'.repeat(64)),
    }, new AbortController().signal);

    // Then
    expect(same).toBe(first);
    await expect(other).rejects.toMatchObject({ code: 'START_BLOCKED' });
    controller.abort();
    gate.resolve();
    await expect(first).rejects.toMatchObject({ code: 'START_ABORTED' });
  });

  it('rejects an inexact MediaMTX preflight without spawning', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false, ['court-1', 'court-2', 'court-3']));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When / Then
    await expect(pipeline.start(target(), new AbortController().signal)).rejects.toMatchObject({ code: 'MEDIA_FAILED' });
    expect(context.spawner.calls).toHaveLength(0);
  });

  it('maps an unavailable MediaMTX API preflight without spawning', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueueFailure();
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When / Then
    await expect(pipeline.start(target(), new AbortController().signal)).rejects.toMatchObject({ code: 'MEDIA_FAILED' });
    expect(context.spawner.calls).toHaveLength(0);
  });

  it('fails when the process closes before the dual gate opens', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(false));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    const started = pipeline.start(target(), new AbortController().signal);
    await flushUntil(() => context.spawner.calls.length === 1);
    context.process.finish({ code: 1, signal: null });

    // Then
    await expect(started).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect(context.process.releaseCalls).toBe(1);
  });

  it('attributes a signaled process close to process failure', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(false));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), new AbortController().signal);
    await flushUntil(() => context.spawner.calls.length === 1);

    // When
    context.process.finish({ code: null, signal: 'SIGKILL' });

    // Then
    await expect(started).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect(context.process.releaseCalls).toBe(1);
  });

  it('accepts advancing output time when the frame counter remains zero', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    const started = pipeline.start(target(), new AbortController().signal);
    context.bytes.push(progress(0, 'continue', '1000'));

    // Then
    const runtime = await started;
    expect(runtime.appliedDesiredVersion).toBe(3);
    await pipeline.stop(runtime, new AbortController().signal);
  });

  it('accepts monotonic negative output time when the frame counter remains zero', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    const started = pipeline.start(target(), new AbortController().signal);
    context.bytes.push(progress(0, 'continue', '-100'));
    context.bytes.push(progress(0, 'continue', '-50'));

    // Then
    await expect(started).resolves.toMatchObject({ appliedDesiredVersion: 3 });
    await pipeline.stop(await started, new AbortController().signal);
  });

  it('does not publish a runtime from an advancing progress=end record', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    const started = pipeline.start(target(), new AbortController().signal);
    context.bytes.push(progress(1, 'end'));

    // Then
    await expect(started).rejects.toMatchObject({ code: 'PROGRESS_FAILED' });
    await expect(pipeline.getRuntime(target().output.id, new AbortController().signal)).resolves.toBeNull();
  });

  it('does not treat frame zero with N/A output time as ready', async () => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    context.bytes.push(progress(0));
    const started = pipeline.start(target(), new AbortController().signal);
    await flushUntil(() => context.inspector.signals.length === 2);

    // Then
    await expectPending(started);
    context.bytes.push(progress(1));
    await expect(started).resolves.toBeDefined();
    await pipeline.stop(await started, new AbortController().signal);
  });

  it('maps a missing fd3 and startup timeout to typed failures', async () => {
    // Given
    const missing = createContext({ progress: false });
    const timed = createContext();
    missing.inspector.enqueue(snapshot(false));
    timed.inspector.enqueue(snapshot(false));
    timed.inspector.enqueue(snapshot(false));

    // When / Then
    await expect(new FfmpegCourtPipeline(missing.options).start(target(), new AbortController().signal)).rejects.toMatchObject({ code: 'PROGRESS_FAILED' });
    const operation = new FfmpegCourtPipeline(timed.options).start(target(), new AbortController().signal);
    await flushUntil(() => timed.scheduler.waits.some(({ delayMs }) => delayMs === 10_000));
    timed.scheduler.advance(10_000);
    await expect(operation).rejects.toMatchObject({ code: 'START_TIMEOUT' });
  });

  it.each([
    ['malformed progress', new TextEncoder().encode('bad\n'), false],
    ['EOF without end', progress(1), true],
  ] as const)('maps %s to progress failure', async (_label, chunk, end) => {
    // Given
    const context = createContext();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(false));
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    const started = pipeline.start(target(), new AbortController().signal);
    context.bytes.push(chunk);
    if (end) context.process.finish();

    // Then
    await expect(started).rejects.toMatchObject({ code: 'PROGRESS_FAILED' });
  });
});
