import { describe, expect, it } from 'vitest';
import { MediaMtxApiClientError } from '../src/mediamtx-api-client.js';
import { MediaMtxService } from '../src/mediamtx-service.js';
import {
  FakeApiClient,
  FakeArtifact,
  FakeCredential,
  FakeProcess,
  ManualScheduler,
  itemAt,
  mediaConfig,
  snapshot,
} from './mediamtx-service-fixture.js';

describe('MediaMTX same-instance restart after failed startup', () => {
  it.each(['spawn', 'readiness'] as const)('starts a new generation after terminal %s failure', async (stage) => {
    // Given
    const artifacts = [new FakeArtifact(), new FakeArtifact()];
    const credentials = [new FakeCredential(), new FakeCredential()];
    const firstProcess = new FakeProcess();
    const secondProcess = new FakeProcess();
    const client = new FakeApiClient(stage === 'readiness'
      ? [new MediaMtxApiClientError('AUTH_FAILED')]
      : []);
    let artifactIndex = 0;
    let credentialIndex = 0;
    let spawnCalls = 0;
    let spawnFailureEnabled = stage === 'spawn';
    const service = new MediaMtxService({
      config: mediaConfig(),
      runtimeFiles: { create: async () => itemAt(artifacts, artifactIndex++) },
      spawner: {
        spawn: async () => {
          spawnCalls += 1;
          if (spawnFailureEnabled) throw new TypeError('private spawn failure');
          return spawnCalls === 1 ? firstProcess : secondProcess;
        },
      },
      scheduler: new ManualScheduler(),
      credentialFactory: { create: () => itemAt(credentials, credentialIndex++) },
      apiClientFactory: { create: () => client },
    });

    // When
    await expect(service.start()).rejects.toMatchObject({ code: 'START_FAILED' });
    spawnFailureEnabled = false;
    client.outcomes = [snapshot()];
    await service.start();
    await service.stop();

    // Then
    expect(service.status()).toEqual({ state: 'idle' });
    expect(artifactIndex).toBe(2);
    expect(spawnCalls).toBe(2);
    expect(credentialIndex).toBe(2);
    expect(artifacts.map(({ cleanupCalls }) => cleanupCalls)).toEqual([1, 1]);
    expect(credentials.map(({ disposeCalls }) => disposeCalls)).toEqual([1, 1]);
    expect(firstProcess.releaseCalls).toBe(stage === 'readiness' ? 1 : 0);
    expect(secondProcess.releaseCalls).toBe(1);
  });
});
