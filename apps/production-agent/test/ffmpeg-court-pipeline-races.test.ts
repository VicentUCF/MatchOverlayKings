import { OutputIdSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import { ByteQueue, createContext, deferred, expectPending, FakeProcess, flushUntil, progress, snapshot, target } from './ffmpeg-court-pipeline-fixture.js';

async function startPipeline() {
  const context = createContext();
  context.inspector.enqueue(snapshot(false));
  context.inspector.enqueue(snapshot(true));
  const pipeline = new FfmpegCourtPipeline(context.options);
  const started = pipeline.start(target(), new AbortController().signal);
  context.bytes.push(progress(1));
  return { context, pipeline, runtime: await started };
}

describe('FFmpeg court pipeline races and recovery', () => {
  it('keeps getRuntime a pure projection and returns the actual mismatched runtime', async () => {
    // Given
    const fixture = await startPipeline();
    const calls = fixture.context.inspector.signals.length;

    // When
    const actual = await fixture.pipeline.getRuntime(OutputIdSchema.parse('10000000-0000-4000-8000-000000000099'), new AbortController().signal);

    // Then
    expect(actual).toBe(fixture.runtime);
    expect(fixture.context.inspector.signals).toHaveLength(calls);
    expect(fixture.context.process.signals).toHaveLength(0);
    await fixture.pipeline.stop(fixture.runtime, new AbortController().signal);
  });

  it('detaches a settled start signal from the running generation', async () => {
    // Given
    const context = createContext();
    const controller = new AbortController();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), controller.signal);
    context.bytes.push(progress(1));
    const runtime = await started;

    // When
    controller.abort();
    await Promise.resolve();

    // Then
    expect(await pipeline.getRuntime(runtime.outputId, new AbortController().signal)).toBe(runtime);
    await pipeline.stop(runtime, new AbortController().signal);
  });

  it('coalesces concurrent stops and releases once', async () => {
    // Given
    const fixture = await startPipeline();

    // When
    const first = fixture.pipeline.stop(fixture.runtime, new AbortController().signal);
    const second = fixture.pipeline.stop(fixture.runtime, new AbortController().signal);

    // Then
    expect(second).toBe(first);
    await first;
    expect(fixture.context.process.releaseCalls).toBe(1);
  });

  it('enters cleanupPending after release failure and matching stop completes without another release', async () => {
    // Given
    const fixture = await startPipeline();
    fixture.context.process.releaseFailures = 1;

    // When
    await expect(fixture.pipeline.stop(fixture.runtime, new AbortController().signal)).rejects.toMatchObject({ code: 'STOP_FAILED' });

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).rejects.toMatchObject({ code: 'INSPECTION_BLOCKED' });
    await expect(fixture.pipeline.start(target(), new AbortController().signal)).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    await expect(fixture.pipeline.stop(fixture.runtime, new AbortController().signal)).resolves.toBeUndefined();
    expect(fixture.context.process.releaseCalls).toBe(1);
  });

  it('uses an aborted stop signal for urgency while cleanup continues', async () => {
    // Given
    const fixture = await startPipeline();
    fixture.context.process.closeOn = 'SIGKILL';
    const controller = new AbortController();
    controller.abort();

    // When
    await fixture.pipeline.stop(fixture.runtime, controller.signal);

    // Then
    expect(fixture.context.process.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fixture.context.process.releaseCalls).toBe(1);
  });

  it('accelerates an already-coalesced teardown when its later stop signal aborts', async () => {
    // Given
    const fixture = await startPipeline();
    fixture.context.process.closeOn = 'SIGKILL';
    fixture.context.inspector.enqueue(snapshot(false));
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.process.signals.includes('SIGTERM'));
    const controller = new AbortController();

    // When
    const stopped = fixture.pipeline.stop(fixture.runtime, controller.signal);
    controller.abort();

    // Then
    await expect(stopped).resolves.toBeUndefined();
    expect(fixture.context.process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('recovers cleanupPending when a signal-failed process later closes', async () => {
    // Given
    const fixture = await startPipeline();
    fixture.context.process.failSignal = 'SIGTERM';
    fixture.context.process.closeOn = null;

    // When
    await expect(fixture.pipeline.stop(fixture.runtime, new AbortController().signal)).rejects.toMatchObject({ code: 'STOP_FAILED' });
    fixture.context.process.finish({ code: 1, signal: null });
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });

  it('does not let stale generation work mutate its replacement', async () => {
    // Given
    const fixture = await startPipeline();
    const lateInspection = deferred<ReturnType<typeof snapshot>>();
    fixture.context.inspector.enqueue(lateInspection.promise);
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.inspector.signals.length === 3);
    const stopped = fixture.pipeline.stop(fixture.runtime, new AbortController().signal);
    await flushUntil(() => fixture.context.scheduler.waits.filter(({ delayMs }) => delayMs === 2_000).length >= 2
      && fixture.context.scheduler.waits.some(({ delayMs, signal }) => delayMs === 2_000 && !signal.aborted));
    fixture.context.scheduler.advance(2_000);
    await stopped;
    const nextBytes = new ByteQueue();
    const nextProcess = new FakeProcess(nextBytes);
    fixture.context.spawner.process = nextProcess;
    fixture.context.inspector.enqueue(snapshot(false));
    fixture.context.inspector.enqueue(snapshot(true));
    const nextStart = fixture.pipeline.start(target(), new AbortController().signal);
    nextBytes.push(progress(1));
    const replacement = await nextStart;

    // When
    lateInspection.resolve(snapshot(false));
    await Promise.resolve();

    // Then
    expect(await fixture.pipeline.getRuntime(replacement.outputId, new AbortController().signal)).toBe(replacement);
    await expect(fixture.pipeline.stop(fixture.runtime, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_MISMATCH' });
    await fixture.pipeline.stop(replacement, new AbortController().signal);
  });

  it('owns exactly one progress consumer for one generation', async () => {
    // Given
    const fixture = await startPipeline();

    // When
    const runtime = await fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal);

    // Then
    expect(fixture.context.bytes.consumers).toBe(1);
    await fixture.pipeline.stop(runtime ?? fixture.runtime, new AbortController().signal);
  });

  it.each(['preflight', 'spawn', 'progress', 'media'] as const)('cancels startup during %s with fresh cleanup intent', async (phase) => {
    // Given
    const context = createContext();
    const controller = new AbortController();
    const gate = deferred<void>();
    if (phase === 'preflight') context.inspector.enqueue(gate.promise.then(() => snapshot(false)));
    else {
      context.inspector.enqueue(snapshot(false));
      if (phase === 'spawn') context.spawner.barrier = gate.promise;
      else context.inspector.enqueue(phase === 'media' ? gate.promise.then(() => snapshot(true)) : snapshot(false));
    }
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), controller.signal);
    if (phase === 'preflight') await flushUntil(() => context.inspector.signals.length === 1);
    if (phase === 'spawn') await flushUntil(() => context.spawner.calls.length === 1);
    if (phase === 'progress' || phase === 'media') {
      await flushUntil(() => context.inspector.signals.length === 2);
    }

    // When
    controller.abort();
    gate.resolve();

    // Then
    await expect(started).rejects.toMatchObject({ code: 'START_ABORTED' });
    if (phase !== 'preflight') await flushUntil(() => context.process.releaseCalls === 1);
    expect(context.process.signals.includes('SIGTERM') || phase === 'preflight').toBe(true);
  });

  it('cancels startup while an overlay pump is active without surfacing its abort', async () => {
    // Given
    const context = createContext({ overlay: true });
    const controller = new AbortController();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(false));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(true), controller.signal);
    await flushUntil(() => context.process.pumpCalls === 1);

    // When
    controller.abort();

    // Then
    await expect(started).rejects.toMatchObject({ code: 'START_ABORTED' });
    expect(context.process.releaseCalls).toBe(1);
  });

  it('blocks inspection while startup is unresolved', async () => {
    // Given
    const context = createContext();
    const gate = deferred<ReturnType<typeof snapshot>>();
    context.inspector.enqueue(gate.promise);
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), new AbortController().signal);

    // When / Then
    await expect(pipeline.getRuntime(target().output.id, new AbortController().signal)).rejects.toMatchObject({ code: 'INSPECTION_BLOCKED' });
    await expectPending(started);
  });
});
