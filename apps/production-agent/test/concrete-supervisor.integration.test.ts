import { describe, expect, it } from 'vitest';
import {
  FfmpegCourtPipeline,
  FfmpegCourtPipelineError,
  type FfmpegCourtPipelineErrorCode,
  type FfmpegCourtPipelineLifecycle,
  type FfmpegCourtPipelineOptions,
} from '../src/index.js';
import {
  activeSnapshots,
  createConcreteSupervisorFixture,
  prepareNextGeneration,
  secondCourtStoppedSnapshots,
} from './concrete-supervisor-fixture.js';
import { flushUntil } from './ffmpeg-court-pipeline-fixture.js';

describe('concrete Supervisor media composition', () => {
  it('admits the first three concrete pipelines and capacity-defers the fourth', async () => {
    // Given
    const fixture = await createConcreteSupervisorFixture();
    const publicOptions: FfmpegCourtPipelineOptions = fixture.pipelineOptions[0];
    const publicLifecycle: FfmpegCourtPipelineLifecycle = 'running';
    const publicCode: FfmpegCourtPipelineErrorCode = 'PROCESS_FAILED';

    // When
    const result = await fixture.supervisor.reconcile(activeSnapshots());

    // Then
    expect(fixture.pipelines[0]).toBeInstanceOf(FfmpegCourtPipeline);
    expect(new FfmpegCourtPipelineError(publicCode).code).toBe(publicCode);
    expect([publicOptions.courtId, publicLifecycle]).toEqual([fixture.pipelineOptions[0].courtId, 'running']);
    expect(result.courts.map(({ kind }) => kind)).toEqual([
      'reconciled', 'reconciled', 'reconciled', 'degraded',
    ]);
    expect(result.courts[3]).toMatchObject({ kind: 'degraded', reason: 'capacity' });
    expect(fixture.courts.map(({ spawner }) => spawner.calls.length)).toEqual([1, 1, 1, 0]);
    expect(fixture.tracker.peak).toBe(3);
    expect(fixture.mediaSpawner.calls).toHaveLength(1);

    await fixture.supervisor.shutdown();
    await fixture.mediaService.stop();
  });

  it('stops a deactivated incumbent and starts the queued court exactly once', async () => {
    // Given
    const fixture = await createConcreteSupervisorFixture();
    await fixture.supervisor.reconcile(activeSnapshots());

    // When
    const result = await fixture.supervisor.reconcile(secondCourtStoppedSnapshots());

    // Then
    expect(result.courts.map(({ kind }) => kind)).toEqual([
      'reconciled', 'reconciled', 'reconciled', 'reconciled',
    ]);
    expect(fixture.courts.map(({ spawner }) => spawner.calls.length)).toEqual([1, 1, 1, 1]);
    expect(fixture.courts[0].processes[0]?.status()).toEqual({ state: 'running' });
    expect(fixture.courts[2].processes[0]?.status()).toEqual({ state: 'running' });
    expect(fixture.courts[0].processes[0]?.releaseCalls).toBe(0);
    expect(fixture.courts[1].processes[0]?.releaseCalls).toBe(1);
    expect(fixture.courts[2].processes[0]?.releaseCalls).toBe(0);
    expect(fixture.tracker.peak).toBe(3);

    await fixture.supervisor.shutdown();
    await fixture.mediaService.stop();
  });

  it('isolates an abnormal FFmpeg close and deterministically recovers that court', async () => {
    // Given
    const fixture = await createConcreteSupervisorFixture();
    await fixture.supervisor.reconcile(activeSnapshots());
    const failedProcess = fixture.courts[1].processes[0];
    if (failedProcess === undefined) throw new TypeError('Missing admitted FFmpeg process');

    // When
    failedProcess.finish({ code: 7, signal: null });
    await flushUntil(() => failedProcess.releaseCalls === 1);
    const recoveredProcess = prepareNextGeneration(fixture, 1);
    const result = await fixture.supervisor.reconcile(activeSnapshots());

    // Then
    expect(result.courts.map(({ kind }) => kind)).toEqual([
      'reconciled', 'reconciled', 'reconciled', 'degraded',
    ]);
    expect(fixture.courts.map(({ spawner }) => spawner.calls.length)).toEqual([1, 2, 1, 0]);
    expect(failedProcess.releaseCalls).toBe(1);
    expect(recoveredProcess.status()).toEqual({ state: 'running' });
    expect(fixture.courts[0].processes[0]?.releaseCalls).toBe(0);
    expect(fixture.courts[2].processes[0]?.releaseCalls).toBe(0);
    expect(fixture.tracker.peak).toBe(3);

    await fixture.supervisor.shutdown();
    await fixture.mediaService.stop();
  });

  it('shuts down admitted pipelines idempotently without owning shared MediaMTX', async () => {
    // Given
    const fixture = await createConcreteSupervisorFixture();
    await fixture.supervisor.reconcile(activeSnapshots());

    // When
    const firstShutdown = fixture.supervisor.shutdown();
    const concurrentShutdown = fixture.supervisor.shutdown();
    const shutdown = await firstShutdown;
    const completedShutdown = fixture.supervisor.shutdown();
    const postShutdown = await fixture.supervisor.reconcile(activeSnapshots());

    // Then
    expect(concurrentShutdown).toBe(firstShutdown);
    expect(completedShutdown).toBe(firstShutdown);
    expect(shutdown.courts.map(({ kind }) => kind)).toEqual(['stopped', 'stopped', 'stopped', 'idle']);
    expect(postShutdown.courts.map(({ kind }) => kind)).toEqual([
      'cancelled', 'cancelled', 'cancelled', 'cancelled',
    ]);
    expect(fixture.courts.map(({ spawner }) => spawner.calls.length)).toEqual([1, 1, 1, 0]);
    expect(fixture.courts.map(({ processes }) => processes[0]?.releaseCalls)).toEqual([1, 1, 1, 0]);
    expect(fixture.courts[3].processes[0]?.signals).toEqual([]);
    expect(fixture.mediaService.status().state).toBe('running');
    expect(fixture.mediaProcess.signals).toEqual([]);
    expect(fixture.mediaProcess.releaseCalls).toBe(0);

    await fixture.mediaService.stop();
    expect(fixture.mediaProcess.signals).toEqual(['SIGINT']);
    expect(fixture.mediaProcess.releaseCalls).toBe(1);
    expect(fixture.mediaArtifact.cleanupCalls).toBe(1);
    expect(fixture.mediaCredential.disposeCalls).toBe(1);
  });
});
