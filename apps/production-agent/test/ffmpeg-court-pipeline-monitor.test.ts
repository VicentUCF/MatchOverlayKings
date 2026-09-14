import { describe, expect, it } from 'vitest';
import { createFfmpegCourtGeneration, recordGenerationFault } from '../src/ffmpeg-court-generation.js';
import { monitorFfmpegGeneration } from '../src/ffmpeg-court-monitor.js';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import { resolveFfmpegCourtPlan } from '../src/ffmpeg-court-plan.js';
import { PipelineRuntimeSchema } from '../src/models.js';
import {
  createContext,
  deferred,
  flushUntil,
  progress,
  snapshot,
  target,
} from './ffmpeg-court-pipeline-fixture.js';

async function running(settings: { readonly overlay?: boolean; readonly healthTimeoutMs?: number } = {}) {
  const context = createContext(settings);
  context.inspector.enqueue(snapshot(false));
  context.inspector.enqueue(snapshot(true));
  const pipeline = new FfmpegCourtPipeline(context.options);
  const started = pipeline.start(target(settings.overlay === true), new AbortController().signal);
  context.bytes.push(progress(1));
  const runtime = await started;
  return { context, pipeline, runtime };
}

describe('FFmpeg court pipeline monitoring', () => {
  it('uses the earlier progress deadline while a later media inspection is pending', async () => {
    // Given
    const context = createContext({ healthTimeoutMs: 250 });
    const pendingInspection = deferred<ReturnType<typeof snapshot>>();
    const pipelineTarget = target();
    const runtime = PipelineRuntimeSchema.parse({
      outputId: pipelineTarget.output.id,
      appliedDesiredVersion: pipelineTarget.desired.version,
      profileFingerprint: pipelineTarget.profileFingerprint,
    });
    const generation = createFfmpegCourtGeneration(pipelineTarget, runtime, 250);
    generation.plan = resolveFfmpegCourtPlan(context.options, pipelineTarget);
    generation.progressReady = true;
    generation.mediaReady = true;
    generation.lastProgressAdvanceMs = 0;
    generation.lastMediaSuccessMs = 100;
    context.scheduler.now = 200;
    context.inspector.enqueue(pendingInspection.promise);
    const faults: string[] = [];
    const monitored = monitorFfmpegGeneration({
      generation,
      pipeline: context.options,
      changed: () => undefined,
      failed: (fault) => {
        faults.push(fault);
        recordGenerationFault(generation, fault);
      },
    });
    await flushUntil(() => context.inspector.signals.length === 1 && context.scheduler.waits.length === 1);
    const deadlineWait = context.scheduler.waits[0];
    if (deadlineWait === undefined) throw new TypeError('Missing monitor deadline');

    // When
    context.scheduler.advance(deadlineWait.delayMs);
    await monitored;
    pendingInspection.resolve(snapshot(true));

    // Then
    expect(context.scheduler.now).toBe(250);
    expect(context.inspector.signals[0]?.aborted).toBe(true);
    expect(faults).toEqual(['PROGRESS_FAILED']);
  });

  it('refreshes the progress deadline while a media inspection is pending', async () => {
    // Given
    const context = createContext({ healthTimeoutMs: 250 });
    const pendingInspection = deferred<ReturnType<typeof snapshot>>();
    const pipelineTarget = target();
    const runtime = PipelineRuntimeSchema.parse({
      outputId: pipelineTarget.output.id,
      appliedDesiredVersion: pipelineTarget.desired.version,
      profileFingerprint: pipelineTarget.profileFingerprint,
    });
    const generation = createFfmpegCourtGeneration(pipelineTarget, runtime, 250);
    generation.plan = resolveFfmpegCourtPlan(context.options, pipelineTarget);
    generation.progressReady = true;
    generation.mediaReady = true;
    generation.lastProgressAdvanceMs = 0;
    generation.lastMediaSuccessMs = 100;
    context.scheduler.now = 200;
    context.inspector.enqueue(pendingInspection.promise);
    const faults: string[] = [];
    const monitored = monitorFfmpegGeneration({
      generation,
      pipeline: context.options,
      changed: () => undefined,
      failed: (fault) => {
        faults.push(fault);
        recordGenerationFault(generation, fault);
      },
    });
    await flushUntil(() => context.inspector.signals.length === 1 && context.scheduler.waits.length === 1);
    const originalProgressWake = context.scheduler.waits[0];
    if (originalProgressWake === undefined) throw new TypeError('Missing progress wake');

    // When
    context.scheduler.now = 240;
    generation.lastProgressAdvanceMs = 240;
    context.scheduler.now = 250;
    originalProgressWake.finish();
    await flushUntil(() => faults.length > 0 || context.scheduler.waits.some(({ delayMs, signal }) => (
      delayMs === 100 && !signal.aborted
    )));
    const faultsAtOriginalWake = [...faults];
    const abortedAtOriginalWake = context.inspector.signals[0]?.aborted;
    const mediaWake = context.scheduler.waits.find(({ delayMs, signal }) => delayMs === 100 && !signal.aborted);
    if (mediaWake === undefined) {
      pendingInspection.resolve(snapshot(true));
    } else {
      context.scheduler.advance(mediaWake.delayMs);
    }
    await monitored;
    pendingInspection.resolve(snapshot(true));

    // Then
    expect(faultsAtOriginalWake).toEqual([]);
    expect(abortedAtOriginalWake).toBe(false);
    expect(context.scheduler.now).toBe(350);
    expect(context.inspector.signals[0]?.aborted).toBe(true);
    expect(faults).toEqual(['MEDIA_FAILED']);
  });

  it('aborts a pending inspection at the absolute media health deadline', async () => {
    // Given
    const context = createContext({ healthTimeoutMs: 100 });
    const inspection = deferred<ReturnType<typeof snapshot>>();
    const controller = new AbortController();
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(inspection.promise);
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(), controller.signal);
    let outcome: string | null = null;
    void started.then(
      () => { outcome = 'resolved'; },
      (error: unknown) => { outcome = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'; },
    );
    context.bytes.push(progress(1));
    await flushUntil(() => context.inspector.signals.length === 2);

    // When
    context.scheduler.advance(100);
    await flushUntil(() => outcome !== null);
    const deadlineOutcome = outcome;
    const requestAborted = context.inspector.signals[1]?.aborted;
    controller.abort();
    inspection.resolve(snapshot(true));
    await expect(started).rejects.toBeDefined();

    // Then
    expect(deadlineOutcome).toBe('MEDIA_FAILED');
    expect(requestAborted).toBe(true);
  });

  it('moves synchronously away from running when the path drops', async () => {
    // Given
    const fixture = await running({ healthTimeoutMs: 100 });
    fixture.context.inspector.enqueue(snapshot(false));

    // When
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
    expect(fixture.context.process.releaseCalls).toBe(1);
  });

  it('allows inspector rejection only within the health budget', async () => {
    // Given
    const fixture = await running({ healthTimeoutMs: 200 });
    fixture.context.inspector.enqueueFailure();
    fixture.context.inspector.enqueueFailure();

    // When
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.scheduler.waits.filter(({ delayMs }) => delayMs === 100).length >= 2);
    expect(await fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).toBe(fixture.runtime);
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });

  it('fails a terminal MediaMTX inspection error without spending the retry budget', async () => {
    // Given
    const fixture = await running({ healthTimeoutMs: 5_000 });
    fixture.context.inspector.enqueueFailure('AUTH_FAILED');

    // When
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });

  it('expires a retryable MediaMTX failure at the exact health deadline', async () => {
    // Given
    const fixture = await running({ healthTimeoutMs: 100 });
    fixture.context.inspector.enqueueFailure('REQUEST_FAILED');

    // When
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });

  it('fails a stalled progress generation after the health budget', async () => {
    // Given
    const fixture = await running({ healthTimeoutMs: 100 });
    fixture.context.inspector.enqueue(snapshot(true));

    // When
    fixture.context.scheduler.advance(100);
    await flushUntil(() => fixture.context.process.releaseCalls === 1);

    // Then
    await expect(fixture.pipeline.getRuntime(fixture.runtime.outputId, new AbortController().signal)).resolves.toBeNull();
  });

  it('gives an overlay rejection precedence over the resulting process close', async () => {
    // Given
    const context = createContext({ overlay: true });
    const pump = deferred<void>();
    context.process.pumpResult = pump.promise;
    context.inspector.enqueue(snapshot(false));
    context.inspector.enqueue(snapshot(true));
    const pipeline = new FfmpegCourtPipeline(context.options);
    const started = pipeline.start(target(true), new AbortController().signal);
    context.bytes.push(progress(1));
    const runtime = await started;

    // When
    pump.reject(new Error('private'));
    await flushUntil(() => context.process.releaseCalls === 1);

    // Then
    expect(context.process.pumpCalls).toBe(1);
    await expect(pipeline.getRuntime(runtime.outputId, new AbortController().signal)).resolves.toBeNull();
    expect(context.process.releaseCalls).toBe(1);
  });

  it('never creates or pumps fd4 when overlay is disabled', async () => {
    // Given
    const fixture = await running();

    // When
    await fixture.pipeline.stop(fixture.runtime, new AbortController().signal);

    // Then
    expect(fixture.context.process.pumpCalls).toBe(0);
  });
});
