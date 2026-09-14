import { describe, expect, it } from 'vitest';
import type { MediaMtxPathsSnapshot } from '../src/mediamtx-api-client.js';
import { MediaMtxService } from '../src/mediamtx-service.js';
import {
  FakeApiClient,
  FakeArtifact,
  FakeCredential,
  FakeProcess,
  FakeRuntimeFiles,
  FakeSpawner,
  ManualScheduler,
  PATHS,
  expectPending,
  flushUntil,
  mediaConfig,
  snapshot,
} from './mediamtx-service-fixture.js';

function harness(client: FakeApiClient) {
  const process = new FakeProcess();
  const artifact = new FakeArtifact();
  const credential = new FakeCredential();
  const service = new MediaMtxService({
    config: mediaConfig(),
    runtimeFiles: new FakeRuntimeFiles(artifact),
    spawner: new FakeSpawner(process),
    scheduler: new ManualScheduler(),
    credentialFactory: { create: () => credential },
    apiClientFactory: { create: () => client },
  });
  return { service, process, artifact, credential };
}

describe('MediaMTX running inspection', () => {
  it('returns a fresh immutable authenticated snapshot and refreshes safe status', async () => {
    // Given
    const fresh = snapshot([...PATHS].reverse());
    const client = new FakeApiClient([snapshot(), fresh]);
    const test = harness(client);
    await test.service.start();

    // When
    const result = await test.service.inspectPaths(new AbortController().signal);

    // Then
    expect(result).toEqual(fresh);
    expect(client.calls).toBe(2);
    expect(test.service.status()).toEqual({ state: 'running', paths: fresh.items });
    expect(test.credential.disposeCalls).toBe(0);
    await test.service.stop();
    expect(test.credential.disposeCalls).toBe(1);
  });

  it('aborts and joins an active inspection before disposing credentials', async () => {
    // Given
    let resolveInspection = (value: MediaMtxPathsSnapshot): void => { void value; };
    const pending = new Promise<MediaMtxPathsSnapshot>((resolve) => { resolveInspection = resolve; });
    const client = new FakeApiClient([snapshot(), pending]);
    const test = harness(client);
    await test.service.start();
    const inspection = test.service.inspectPaths(new AbortController().signal);
    await flushUntil(() => client.calls === 2);

    // When
    const stop = test.service.stop();
    await expectPending(stop);
    expect(client.signals[1]?.aborted).toBe(true);
    expect(test.credential.disposeCalls).toBe(0);
    resolveInspection(snapshot());

    // Then
    await expect(inspection).resolves.toEqual(snapshot());
    await expect(stop).resolves.toBeUndefined();
    expect(test.credential.disposeCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
  });

  it('rejects inspection outside the running state', async () => {
    const test = harness(new FakeApiClient());
    await expect(test.service.inspectPaths(new AbortController().signal))
      .rejects.toMatchObject({ code: 'INSPECTION_BLOCKED' });
  });
});
