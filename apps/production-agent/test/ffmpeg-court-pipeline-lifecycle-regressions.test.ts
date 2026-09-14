import { describe, expect, it } from 'vitest';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import {
  createContext,
  deferred,
  expectPending,
  FakeProcess,
  flushMicrotasks,
  flushUntil,
  progress,
  snapshot,
  target,
} from './ffmpeg-court-pipeline-fixture.js';

function advancingThenPending(): AsyncIterable<Uint8Array> {
  let emitted = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: () => {
          if (emitted) return new Promise(() => undefined);
          emitted = true;
          return Promise.resolve({ done: false, value: progress(1) });
        },
      };
    },
  };
}

async function running(overlay = false) {
  const context = createContext({ overlay });
  context.inspector.enqueue(snapshot(false));
  context.inspector.enqueue(snapshot(true));
  const pipeline = new FfmpegCourtPipeline(context.options);
  const started = pipeline.start(target(overlay), new AbortController().signal);
  context.bytes.push(progress(1));
  return { context, pipeline, runtime: await started };
}

describe('FFmpeg court pipeline lifecycle regressions', () => {
  it('starts one absolute startup deadline while preflight is pending', async () => {
    // Given
    const context = createContext();
    const preflight = deferred<ReturnType<typeof snapshot>>();
    context.inspector.enqueue(preflight.promise);
    const pipeline = new FfmpegCourtPipeline(context.options);

    // When
    const started = pipeline.start(target(), new AbortController().signal);
    await flushUntil(() => context.inspector.signals.length === 1);

    // Then
    expect(context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 10_000 && !signal.aborted)).toBe(true);
    context.scheduler.advance(10_000);
    await expect(started).rejects.toMatchObject({ code: 'START_TIMEOUT' });
    expect(context.inspector.signals[0]?.aborted).toBe(true);
    preflight.resolve(snapshot(false));
  });

  it('rejects at the startup deadline and finalizes a late spawn result', async () => {
    // Given
    const context = createContext();
    const spawn = deferred<void>();
    context.inspector.enqueue(snapshot(false));
    context.spawner.barrier = spawn.promise;
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), new AbortController().signal);
    await flushUntil(() => context.spawner.calls.length === 1);

    // When
    expect(context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 10_000 && !signal.aborted)).toBe(true);
    context.scheduler.advance(10_000);

    // Then
    await expect(started).rejects.toMatchObject({ code: 'START_TIMEOUT' });
    spawn.resolve();
    await flushUntil(() => context.process.releaseCalls === 1);
    await expect(pipeline.getRuntime(target().output.id, new AbortController().signal)).resolves.toBeNull();
  });

  it('settles startup cancellation before a non-cancellable spawn returns', async () => {
    // Given
    const context = createContext();
    const spawn = deferred<void>();
    const controller = new AbortController();
    context.inspector.enqueue(snapshot(false));
    context.spawner.barrier = spawn.promise;
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), controller.signal);
    let outcome: string | null = null;
    void started.then(
      () => { outcome = 'resolved'; },
      (error: unknown) => { outcome = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'; },
    );
    await flushUntil(() => context.spawner.calls.length === 1);

    // When
    controller.abort();
    await flushMicrotasks();

    // Then
    expect(outcome).toBe('START_ABORTED');
    spawn.resolve();
    await flushUntil(() => context.process.releaseCalls === 1);
  });

  it('recovers release cleanup autonomously without a second stop call', async () => {
    // Given
    const fixture = await running();
    fixture.context.process.releaseFailures = 1;

    // When
    await expect(fixture.pipeline.stop(fixture.runtime, new AbortController().signal)).rejects.toMatchObject({ code: 'STOP_FAILED' });

    // Then
    expect(fixture.context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 100 && !signal.aborted)).toBe(true);
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.scheduler.waits.filter(({ delayMs }) => delayMs === 2_000).length >= 2);
    await flushMicrotasks();
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });

  it('observes a late close even when fd3 is unavailable', async () => {
    // Given
    const context = createContext({ progress: false });
    context.inspector.enqueue(snapshot(false));
    context.process.failSignal = 'SIGTERM';
    context.process.closeOn = null;
    const pipeline = new FfmpegCourtPipeline(context.options);
    await expect(pipeline.start(target(), new AbortController().signal)).rejects.toMatchObject({ code: 'STOP_FAILED' });

    // When
    context.process.finish({ code: 1, signal: null });
    await flushUntil(() => context.process.releaseCalls === 1);

    // Then
    await expect(pipeline.getRuntime(target().output.id, new AbortController().signal)).resolves.toBeNull();
  });

  it('joins overlay and monitor ownership before releasing process handles', async () => {
    // Given
    const context = createContext({ overlay: true });
    const overlay = deferred<void>();
    const inspection = deferred<ReturnType<typeof snapshot>>();
    context.process.pumpResult = overlay.promise;
    context.process.pumpHonorsAbort = false;
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(true), new AbortController().signal);
    context.bytes.push(progress(1));
    const runtime = await started;
    context.inspector.enqueue(inspection.promise);
    context.scheduler.advance(100);
    await flushUntil(() => context.inspector.signals.length === 3);

    // When
    const stopped = pipeline.stop(runtime, new AbortController().signal);
    await flushUntil(() => context.scheduler.waits.filter(({ delayMs }) => delayMs === 2_000).length >= 2
      && context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 2_000 && !signal.aborted));

    // Then
    await expectPending(stopped);
    expect(context.process.releaseCalls).toBe(0);
    context.scheduler.advance(2_000);
    await expect(stopped).resolves.toBeUndefined();
    expect(context.process.releaseCalls).toBe(1);
  });

  it('bounds a progress consumer that does not finish after process close', async () => {
    // Given
    const context = createContext();
    const process = new FakeProcess(advancingThenPending());
    context.spawner.process = process;
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const runtime = await pipeline.start(target(), new AbortController().signal);

    // When
    const stopped = pipeline.stop(runtime, new AbortController().signal);
    await flushMicrotasks();

    // Then
    await expectPending(stopped);
    expect(process.releaseCalls).toBe(0);
    await flushUntil(() => context.scheduler.waits.filter(({ delayMs }) => delayMs === 2_000).length >= 2
      && context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 2_000 && !signal.aborted));
    context.scheduler.advance(2_000);

    await expect(stopped).resolves.toBeUndefined();
    expect(process.releaseCalls).toBe(1);
  });
});
