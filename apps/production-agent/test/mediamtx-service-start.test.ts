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
  PATHS,
  flushUntil,
  mediaConfig,
  snapshot,
  statuses,
} from './mediamtx-service-fixture.js';

function harness(client = new FakeApiClient()) {
  const process = new FakeProcess();
  const artifact = new FakeArtifact();
  const credential = new FakeCredential();
  const runtimeFiles = new FakeRuntimeFiles(artifact);
  const spawner = new FakeSpawner(process);
  const scheduler = new ManualScheduler();
  const service = new MediaMtxService({
    config: mediaConfig(), runtimeFiles, spawner, scheduler,
    credentialFactory: { create: () => credential },
    apiClientFactory: { create: () => client },
  });
  return { service, process, artifact, credential, runtimeFiles, spawner, scheduler, client };
}

describe('MediaMTX service startup', () => {
  it('starts one child, exposes safe immutable path status, and stops cleanly', async () => {
    // Given
    const test = harness();

    // When
    await test.service.start();

    // Then
    expect(test.service.status()).toEqual({ state: 'running', paths: statuses() });
    expect(Object.isFrozen(test.service.status())).toBe(true);
    expect(test.spawner.calls).toHaveLength(1);
    expect(test.credential.disposeCalls).toBe(0);
    await test.service.stop();
    expect(test.service.status()).toEqual({ state: 'idle' });
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
    expect(test.credential.disposeCalls).toBe(1);
  });

  it('coalesces concurrent starts and makes a running start a no-op', async () => {
    // Given
    let releaseProbe = (): void => undefined;
    const probe = new Promise<never>((_resolve, reject) => { releaseProbe = () => reject(new MediaMtxApiClientError('REQUEST_FAILED')); });
    const client = new FakeApiClient([probe, snapshot()]);
    const test = harness(client);

    // When
    const first = test.service.start();
    const second = test.service.start();
    await flushUntil(() => client.calls === 1);
    releaseProbe();
    await flushUntil(() => test.scheduler.waits.length >= 2);
    const retry = test.scheduler.waits.find(({ delayMs }) => delayMs !== mediaConfig().startupTimeoutMs);
    if (retry === undefined) throw new TypeError('Expected retry wait');
    retry.resolve();
    await Promise.all([first, second]);
    await test.service.start();

    // Then
    expect(test.runtimeFiles.calls).toBe(1);
    expect(test.spawner.calls).toHaveLength(1);
    expect(client.calls).toBe(2);
    await test.service.stop();
  });

  it('aborts a blocked start then reaps with a fresh shutdown signal', async () => {
    // Given
    const client = new FakeApiClient();
    client.listPaths = (signal) => new Promise((_resolve, reject) => {
      client.calls += 1;
      client.signals.push(signal);
      signal.addEventListener('abort', () => reject(new MediaMtxApiClientError('ABORTED')), { once: true });
    });
    const test = harness(client);
    test.process.closeOn = 'SIGTERM';
    const start = test.service.start();
    await flushUntil(() => client.calls === 1);

    // When
    const stop = test.service.stop();
    await flushUntil(() => test.scheduler.count(mediaConfig().stopGraceMs) === 1);

    // Then
    expect(test.process.signals).toEqual(['SIGINT']);
    test.scheduler.advance(mediaConfig().stopGraceMs);
    await expect(start).rejects.toMatchObject({ code: 'START_ABORTED' });
    await expect(stop).resolves.toBeUndefined();
    expect(test.process.signals).toEqual(['SIGINT', 'SIGTERM']);
    expect(test.service.status()).toEqual({ state: 'idle' });
  });

  it('stops a generation blocked in spawn without starting an API probe', async () => {
    // Given
    let releaseSpawn = (): void => undefined;
    const test = harness();
    test.spawner.block = new Promise((resolve) => { releaseSpawn = resolve; });
    const start = test.service.start();
    await flushUntil(() => test.spawner.calls.length === 1);

    // When
    const stop = test.service.stop();
    releaseSpawn();

    // Then
    await expect(start).rejects.toMatchObject({ code: 'START_ABORTED' });
    await expect(stop).resolves.toBeUndefined();
    expect(test.client.calls).toBe(0);
    expect(test.process.signals).toEqual(['SIGINT']);
    expect(test.service.status()).toEqual({ state: 'idle' });
  });

  it('returns to idle after spontaneous running exit', async () => {
    // Given
    const test = harness();
    await test.service.start();

    // When
    test.process.finish({ code: 2, signal: null });
    await flushUntil(() => test.service.status().state === 'idle');

    // Then
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
    expect(test.credential.disposeCalls).toBe(1);
  });

  it('finalizes a process that exits before a blocked readiness probe', async () => {
    // Given
    const client = new FakeApiClient();
    client.listPaths = (signal) => {
      client.calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new MediaMtxApiClientError('ABORTED')), { once: true });
      });
    };
    const test = harness(client);
    const start = test.service.start();
    await flushUntil(() => client.calls === 1);

    // When
    test.process.finish({ code: 1, signal: null });

    // Then
    await expect(start).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(test.service.status()).toEqual({ state: 'idle' });
    expect(test.process.releaseCalls).toBe(1);
    expect(test.artifact.cleanupCalls).toBe(1);
  });

  it('blocks start while stopping', async () => {
    // Given
    const test = harness();
    await test.service.start();
    test.process.closeOn = 'SIGTERM';
    const stop = test.service.stop();
    await flushUntil(() => test.service.status().state === 'stopping');

    // When / Then
    await expect(test.service.start()).rejects.toMatchObject({ code: 'START_BLOCKED' });
    await flushUntil(() => test.scheduler.count(mediaConfig().stopGraceMs) === 1);
    test.scheduler.advance(mediaConfig().stopGraceMs);
    await stop;
  });

  it('never exposes credentials, hashes, YAML, headers, config paths, or PIDs', async () => {
    // Given
    const test = harness(new FakeApiClient([new MediaMtxApiClientError('AUTH_FAILED')]));

    // When
    const start = test.service.start();

    // Then
    await expect(start).rejects.toMatchObject({ code: 'START_FAILED' });
    const diagnostic = JSON.stringify([test.service.status(), await start.catch((error: unknown) => error)]);
    expect(diagnostic).not.toMatch(/SECRET_HEADER_SENTINEL|sha256:|authInternalUsers|mediamtx\.yml|pid/i);
    expect(test.service.status()).toEqual({ state: 'idle' });
  });

  it('uses exactly the configured court path names', async () => {
    // Given
    const test = harness();

    // When
    await test.service.start();

    // Then
    expect(test.service.status()).toEqual({ state: 'running', paths: statuses(PATHS) });
    await test.service.stop();
  });
});
