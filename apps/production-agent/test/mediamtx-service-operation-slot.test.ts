import { describe, expect, it } from 'vitest';
import { MediaMtxApiClientError, type MediaMtxPathsSnapshot } from '../src/mediamtx-api-client.js';
import { MediaMtxService } from '../src/mediamtx-service.js';
import {
  FakeApiClient,
  FakeArtifact,
  FakeCredential,
  FakeProcess,
  ManualScheduler,
  flushUntil,
  itemAt,
  mediaConfig,
  snapshot,
} from './mediamtx-service-fixture.js';

describe('MediaMTX operation-slot ownership', () => {
  it('does not let a stale start completion clear its replacement operation', async () => {
    // Given
    let resolveReplacement = (value: MediaMtxPathsSnapshot): void => { void value; };
    const replacementProbe = new Promise<MediaMtxPathsSnapshot>((resolve) => {
      resolveReplacement = resolve;
    });
    const client = new FakeApiClient([
      new MediaMtxApiClientError('AUTH_FAILED'),
      replacementProbe,
    ]);
    const processes = [new FakeProcess(), new FakeProcess()];
    const artifacts = [new FakeArtifact(), new FakeArtifact()];
    const credentials = [new FakeCredential(), new FakeCredential()];
    let processIndex = 0;
    let artifactIndex = 0;
    let credentialIndex = 0;
    const service = new MediaMtxService({
      config: mediaConfig(),
      runtimeFiles: { create: async () => itemAt(artifacts, artifactIndex++) },
      spawner: { spawn: async () => itemAt(processes, processIndex++) },
      scheduler: new ManualScheduler(),
      credentialFactory: { create: () => itemAt(credentials, credentialIndex++) },
      apiClientFactory: { create: () => client },
    });
    let firstSettled = false;
    const firstStart = service.start();
    void firstStart.then(
      () => { firstSettled = true; },
      () => { firstSettled = true; },
    );
    let replacementStart: Promise<void> | null = null;

    // When
    await flushUntil(() => {
      if (service.status().state !== 'idle') return false;
      if (firstSettled) throw new TypeError('First start settled before replacement interleaving');
      replacementStart = service.start();
      return true;
    });
    const ownedReplacement = replacementStart;
    if (ownedReplacement === null) throw new TypeError('Replacement start was not captured');
    await expect(firstStart).rejects.toMatchObject({ code: 'START_FAILED' });
    const coalescedReplacement = service.start();
    void coalescedReplacement.catch(() => undefined);

    // Then
    expect(coalescedReplacement).toBe(ownedReplacement);
    resolveReplacement(snapshot());
    await expect(Promise.all([ownedReplacement, coalescedReplacement]))
      .resolves.toEqual([undefined, undefined]);
    expect(service.status().state).toBe('running');
    await service.stop();
    expect(artifacts.map(({ cleanupCalls }) => cleanupCalls)).toEqual([1, 1]);
    expect(credentials.map(({ disposeCalls }) => disposeCalls)).toEqual([1, 1]);
    expect(processes.map(({ releaseCalls }) => releaseCalls)).toEqual([1, 1]);
  });
});
