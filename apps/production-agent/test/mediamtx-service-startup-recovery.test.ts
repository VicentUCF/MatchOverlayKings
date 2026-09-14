import { describe, expect, it } from 'vitest';
import { MediaMtxApiClientError } from '../src/mediamtx-api-client.js';
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
} from './mediamtx-service-fixture.js';

describe('MediaMTX startup rollback recovery', () => {
  it('coalesces failed rollback and recovery before reusing the service', async () => {
    // Given
    const firstClient = new FakeApiClient();
    firstClient.listPaths = (signal) => new Promise((_resolve, reject) => {
      firstClient.calls += 1;
      firstClient.signals.push(signal);
      signal.addEventListener('abort', () => reject(new MediaMtxApiClientError('ABORTED')), { once: true });
    });
    const secondClient = new FakeApiClient();
    const clients = [firstClient, secondClient];
    const processes = [new FakeProcess(), new FakeProcess()];
    const artifacts = [new FakeArtifact(), new FakeArtifact()];
    const credentials = [new FakeCredential(), new FakeCredential()];
    const firstProcess = itemAt(processes, 0);
    firstProcess.failOn = 'SIGINT';
    let clientIndex = 0;
    let processIndex = 0;
    let artifactIndex = 0;
    let credentialIndex = 0;
    const service = new MediaMtxService({
      config: mediaConfig(),
      runtimeFiles: { create: async () => itemAt(artifacts, artifactIndex++) },
      spawner: { spawn: async () => itemAt(processes, processIndex++) },
      scheduler: new ManualScheduler(),
      credentialFactory: { create: () => itemAt(credentials, credentialIndex++) },
      apiClientFactory: { create: () => itemAt(clients, clientIndex++) },
    });
    const start = service.start();
    await flushUntil(() => firstClient.calls === 1);

    // When
    const firstStop = service.stop();
    const coalescedStop = service.stop();

    // Then
    expect(coalescedStop).toBe(firstStop);
    await expect(Promise.allSettled([start, firstStop])).resolves.toMatchObject([
      { status: 'rejected', reason: { code: 'CLEANUP_PENDING' } },
      { status: 'rejected', reason: { code: 'CLEANUP_PENDING' } },
    ]);
    expect(service.status()).toEqual({ state: 'cleanupPending' });
    expect(itemAt(artifacts, 0).cleanupCalls).toBe(0);
    expect(firstProcess.releaseCalls).toBe(0);
    expect(itemAt(credentials, 0).disposeCalls).toBe(0);

    firstProcess.failOn = null;
    const recovery = service.stop();
    const coalescedRecovery = service.stop();
    expect(coalescedRecovery).toBe(recovery);
    await expect(Promise.all([recovery, coalescedRecovery])).resolves.toEqual([undefined, undefined]);
    expect(firstProcess.signals).toEqual(['SIGINT', 'SIGINT']);
    expect(firstProcess.releaseCalls).toBe(1);
    expect(itemAt(artifacts, 0).cleanupCalls).toBe(1);
    expect(itemAt(credentials, 0).disposeCalls).toBe(1);
    expect(service.status()).toEqual({ state: 'idle' });

    await service.start();
    await service.stop();
    expect(processIndex).toBe(2);
    expect(artifactIndex).toBe(2);
    expect(credentialIndex).toBe(2);
    expect(itemAt(processes, 1).releaseCalls).toBe(1);
    expect(itemAt(artifacts, 1).cleanupCalls).toBe(1);
    expect(itemAt(credentials, 1).disposeCalls).toBe(1);
    expect(service.status()).toEqual({ state: 'idle' });
  });
});
