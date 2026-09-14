import { describe, expect, it } from 'vitest';
import { MediaMtxApiClientError, type MediaMtxPathsSnapshot } from '../src/mediamtx-api-client.js';
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
  itemAt,
  mediaConfig,
  snapshot,
} from './mediamtx-service-fixture.js';

describe('MediaMTX service operation ownership', () => {
  it('coalesces stop while artifact creation is blocked and never spawns', async () => {
    // Given
    const process = new FakeProcess();
    const runtimeFiles = new FakeRuntimeFiles(new FakeArtifact());
    let releaseCreate = (): void => undefined;
    runtimeFiles.block = new Promise((resolve) => { releaseCreate = resolve; });
    const spawner = new FakeSpawner(process);
    const service = new MediaMtxService({
      config: mediaConfig(), runtimeFiles, spawner, scheduler: new ManualScheduler(),
      credentialFactory: { create: () => new FakeCredential() },
      apiClientFactory: { create: () => new FakeApiClient() },
    });
    const start = service.start();
    await flushUntil(() => runtimeFiles.calls === 1);

    // When
    const firstStop = service.stop();
    const secondStop = service.stop();
    releaseCreate();

    // Then
    expect(secondStop).toBe(firstStop);
    await expect(start).rejects.toMatchObject({ code: 'START_ABORTED' });
    await expect(firstStop).resolves.toBeUndefined();
    expect(spawner.calls).toEqual([]);
    expect(service.status()).toEqual({ state: 'idle' });
  });

  it('blocks generation reentry until the prior startup probe settles', async () => {
    // Given
    let settleFirst = (): void => undefined;
    let settleSecond = (): void => undefined;
    const firstProbe = new Promise<MediaMtxPathsSnapshot>((_resolve, reject) => {
      settleFirst = () => reject(new MediaMtxApiClientError('REQUEST_FAILED'));
    });
    const secondProbe = new Promise<MediaMtxPathsSnapshot>((resolve) => {
      settleSecond = () => resolve(snapshot());
    });
    const client = new FakeApiClient([firstProbe, secondProbe]);
    const processes = [new FakeProcess(), new FakeProcess()];
    const artifacts = [new FakeArtifact(), new FakeArtifact()];
    let processIndex = 0;
    let artifactIndex = 0;
    const service = new MediaMtxService({
      config: mediaConfig(),
      runtimeFiles: { create: async () => itemAt(artifacts, artifactIndex++) },
      spawner: { spawn: async () => itemAt(processes, processIndex++) },
      scheduler: new ManualScheduler(),
      credentialFactory: { create: () => new FakeCredential() },
      apiClientFactory: { create: () => client },
    });
    const firstStart = service.start();
    await flushUntil(() => client.calls === 1);
    itemAt(processes, 0).finish({ code: 1, signal: null });

    // When
    const coalescedFirst = service.start();
    expect(coalescedFirst).toBe(firstStart);
    settleFirst();
    await expect(Promise.allSettled([firstStart, coalescedFirst])).resolves.toMatchObject([
      { status: 'rejected', reason: { code: 'START_FAILED' } },
      { status: 'rejected', reason: { code: 'START_FAILED' } },
    ]);
    await flushUntil(() => service.status().state === 'idle');
    const secondStart = service.start();
    await flushUntil(() => client.calls === 2);
    const coalescedStart = service.start();
    settleSecond();

    // Then
    await expect(Promise.all([secondStart, coalescedStart])).resolves.toEqual([undefined, undefined]);
    expect(service.status().state).toBe('running');
    await service.stop();
    expect(itemAt(processes, 1).releaseCalls).toBe(1);
    expect(itemAt(artifacts, 1).cleanupCalls).toBe(1);
  });

  it('restarts the same service after a completed generation', async () => {
    // Given
    const processes = [new FakeProcess(), new FakeProcess()];
    const artifacts = [new FakeArtifact(), new FakeArtifact()];
    let processIndex = 0;
    let artifactIndex = 0;
    const service = new MediaMtxService({
      config: mediaConfig(),
      runtimeFiles: { create: async () => itemAt(artifacts, artifactIndex++) },
      spawner: { spawn: async () => itemAt(processes, processIndex++) },
      scheduler: new ManualScheduler(),
      credentialFactory: { create: () => new FakeCredential() },
      apiClientFactory: { create: () => new FakeApiClient() },
    });

    // When
    await service.start();
    await service.stop();
    await service.start();
    await service.stop();

    // Then
    expect(processIndex).toBe(2);
    expect(artifactIndex).toBe(2);
    expect(processes.map(({ releaseCalls }) => releaseCalls)).toEqual([1, 1]);
    expect(artifacts.map(({ cleanupCalls }) => cleanupCalls)).toEqual([1, 1]);
  });

  it.each(['resolve', 'reject'] as const)('does not clean up over a late startup probe %s', async (settlement) => {
    // Given
    let resolveProbe = (value: MediaMtxPathsSnapshot): void => { void value; };
    let rejectProbe = (error: MediaMtxApiClientError): void => { void error; };
    const probe = new Promise<MediaMtxPathsSnapshot>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    const process = new FakeProcess();
    const artifact = new FakeArtifact();
    const credential = new FakeCredential();
    const client = new FakeApiClient([probe]);
    const service = new MediaMtxService({
      config: mediaConfig(),
      runtimeFiles: new FakeRuntimeFiles(artifact),
      spawner: new FakeSpawner(process),
      scheduler: new ManualScheduler(),
      credentialFactory: { create: () => credential },
      apiClientFactory: { create: () => client },
    });
    const start = service.start();
    await flushUntil(() => service.status().state === 'starting');

    // When
    process.finish({ code: 1, signal: null });
    await flushUntil(() => client.signals[0]?.aborted === true);
    await Promise.resolve();
    await Promise.resolve();

    // Then
    expect(credential.disposeCalls).toBe(0);
    expect(artifact.cleanupCalls).toBe(0);
    if (settlement === 'resolve') resolveProbe(snapshot());
    else rejectProbe(new MediaMtxApiClientError('REQUEST_FAILED'));
    await expect(start).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(credential.disposeCalls).toBe(1);
    expect(artifact.cleanupCalls).toBe(1);
  });
});
