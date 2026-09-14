import { describe, expect, it } from 'vitest';
import { MediaMtxApiClientError } from '../src/mediamtx-api-client.js';
import { MediaMtxService } from '../src/mediamtx-service.js';
import {
  FakeApiClient,
  FakeArtifact,
  FakeCredential,
  FakeProcess,
  FakeRuntimeFiles,
  FakeSpawner,
  ManualScheduler,
  flushUntil,
  mediaConfig,
  snapshot,
} from './mediamtx-service-fixture.js';

function harness(client = new FakeApiClient()) {
  const process = new FakeProcess();
  const artifact = new FakeArtifact();
  const credential = new FakeCredential();
  const runtimeFiles = new FakeRuntimeFiles(artifact);
  const spawner = new FakeSpawner(process);
  const service = new MediaMtxService({
    config: mediaConfig(), runtimeFiles, spawner, scheduler: new ManualScheduler(),
    credentialFactory: { create: () => credential },
    apiClientFactory: { create: () => client },
  });
  return { service, process, artifact, credential, runtimeFiles, spawner };
}

describe('MediaMTX service cleanup and recovery', () => {
  it.each(['create', 'spawn', 'readiness'] as const)('cleans a failed %s start', async (stage) => {
    // Given
    const client = new FakeApiClient(stage === 'readiness'
      ? [new MediaMtxApiClientError('AUTH_FAILED')]
      : undefined);
    const test = harness(client);
    if (stage === 'create') test.runtimeFiles.failure = new Error('private create failure');
    if (stage === 'spawn') test.spawner.failure = new Error('private spawn failure');

    // When
    await expect(test.service.start()).rejects.toMatchObject({ code: 'START_FAILED' });

    // Then
    expect(test.service.status()).toEqual({ state: 'idle' });
    expect(test.credential.disposeCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(stage === 'create' ? 0 : 1);
    if (stage !== 'create') test.process.finish();
    test.runtimeFiles.failure = null;
    test.spawner.failure = null;
    client.outcomes = [snapshot()];
    const replacement = harness(client);
    await replacement.service.start();
    await replacement.service.stop();
  });

  it('releases, cleans, and disposes exactly once across concurrent stops', async () => {
    // Given
    const test = harness();
    await test.service.start();

    // When
    await Promise.all([test.service.stop(), test.service.stop()]);
    await test.service.stop();

    // Then
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
    expect(test.credential.disposeCalls).toBe(1);
  });

  it('enters cleanupPending after failed signal delivery and recovers on stop', async () => {
    // Given
    const test = harness();
    await test.service.start();
    test.process.failOn = 'SIGINT';

    // When
    const failedStop = test.service.stop();

    // Then
    await expect(failedStop).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    expect(test.service.status()).toEqual({ state: 'cleanupPending' });
    expect(test.artifact.cleanupCalls).toBe(0);
    await expect(test.service.start()).rejects.toMatchObject({ code: 'START_BLOCKED' });
    test.process.failOn = null;
    await test.service.stop();
    expect(test.service.status()).toEqual({ state: 'idle' });
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
  });

  it('enters cleanupPending after artifact cleanup failure and retries recovery', async () => {
    // Given
    const test = harness();
    test.artifact.cleanupFailures = 1;
    await test.service.start();

    // When
    const failedStop = test.service.stop();

    // Then
    await expect(failedStop).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    expect(test.service.status()).toEqual({ state: 'cleanupPending' });
    expect(test.process.releaseCalls).toBe(1);
    expect(test.credential.disposeCalls).toBe(1);
    await Promise.all([test.service.stop(), test.service.stop()]);
    expect(test.artifact.recoveryCalls).toBe(1);
    expect(test.service.status()).toEqual({ state: 'idle' });
  });

  it('keeps config cleanup after process close during readiness rollback', async () => {
    // Given
    const client = new FakeApiClient([new MediaMtxApiClientError('AUTH_FAILED')]);
    const test = harness(client);
    test.process.closeOn = null;
    const start = test.service.start();
    await flushUntil(() => test.process.signals.includes('SIGINT'));

    // When
    expect(test.artifact.cleanupCalls).toBe(0);
    test.process.finish({ code: null, signal: 'SIGKILL' });

    // Then
    await expect(start).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(test.artifact.cleanupCalls).toBe(1);
    expect(test.process.releaseCalls).toBe(1);
  });

  it('restarts the same service generation after a clean pre-spawn failure', async () => {
    // Given
    const test = harness();
    test.runtimeFiles.failure = new Error('private create failure');
    await expect(test.service.start()).rejects.toMatchObject({ code: 'START_FAILED' });
    test.runtimeFiles.failure = null;

    // When
    await test.service.start();

    // Then
    expect(test.runtimeFiles.calls).toBe(2);
    expect(test.spawner.calls).toHaveLength(1);
    expect(test.service.status().state).toBe('running');
    await test.service.stop();
  });

  it('retains artifact creation cleanup recovery for a later stop attempt', async () => {
    // Given
    const test = harness();
    let recoveryCalls = 0;
    test.runtimeFiles.failure = Object.assign(new Error('private creation cleanup detail'), {
      code: 'CLEANUP_FAILED' as const,
      retryCleanup: async (): Promise<void> => { recoveryCalls += 1; },
    });

    // When
    const start = test.service.start();

    // Then
    await expect(start).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    expect(recoveryCalls).toBe(0);
    expect(test.service.status()).toEqual({ state: 'cleanupPending' });
    await expect(test.service.start()).rejects.toMatchObject({ code: 'START_BLOCKED' });
    await test.service.stop();
    expect(recoveryCalls).toBe(1);
    expect(test.service.status()).toEqual({ state: 'idle' });
  });

  it.each(['credentials', 'handles'] as const)('claims throwing %s cleanup exactly once before recovery', async (stage) => {
    // Given
    const test = harness();
    if (stage === 'credentials') test.credential.disposeFailures = 1;
    else test.process.releaseFailures = 1;
    await test.service.start();

    // When
    await expect(test.service.stop()).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    await test.service.stop();

    // Then
    expect(test.service.status()).toEqual({ state: 'idle' });
    expect(test.credential.disposeCalls).toBe(1);
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
  });

  it('retains cleanup recovery across a failed recovery attempt', async () => {
    // Given
    const test = harness();
    test.artifact.cleanupFailures = 1;
    test.artifact.recoveryFailures = 1;
    await test.service.start();
    await expect(test.service.stop()).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });

    // When / Then
    await expect(test.service.stop()).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });
    await expect(test.service.stop()).resolves.toBeUndefined();
    expect(test.artifact.recoveryCalls).toBe(2);
    expect(test.service.status()).toEqual({ state: 'idle' });
  });

  it('recovers after spontaneous close follows failed signal delivery', async () => {
    // Given
    const test = harness();
    await test.service.start();
    test.process.failOn = 'SIGINT';
    await expect(test.service.stop()).rejects.toMatchObject({ code: 'CLEANUP_PENDING' });

    // When
    test.process.finish({ code: 2, signal: null });
    await flushUntil(() => test.service.status().state === 'idle');

    // Then
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
  });
});
