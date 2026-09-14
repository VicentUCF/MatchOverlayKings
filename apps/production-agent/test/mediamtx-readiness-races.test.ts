import { describe, expect, it } from 'vitest';
import {
  MediaMtxApiClientError,
  type MediaMtxPathsSnapshot,
} from '../src/mediamtx-api-client.js';
import { MediaMtxReadinessError, waitForMediaMtxReadiness } from '../src/mediamtx-readiness.js';
import {
  FakeProcess,
  ManualScheduler,
  PATHS,
  expectPending,
  flushUntil,
  snapshot,
} from './mediamtx-service-fixture.js';

const STARTUP_TIMEOUT_MS = 10_000;

type DeferredSnapshot = {
  readonly promise: Promise<MediaMtxPathsSnapshot>;
  readonly resolve: (value: MediaMtxPathsSnapshot) => void;
  readonly reject: (error: MediaMtxApiClientError) => void;
};

function deferredSnapshot(): DeferredSnapshot {
  let resolvePromise: (value: MediaMtxPathsSnapshot) => void = () => undefined;
  let rejectPromise: (error: MediaMtxApiClientError) => void = () => undefined;
  const promise = new Promise<MediaMtxPathsSnapshot>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function readiness(
  pending: DeferredSnapshot,
  process: FakeProcess,
  scheduler: ManualScheduler,
): Promise<MediaMtxPathsSnapshot> {
  return waitForMediaMtxReadiness({
    client: { listPaths: () => pending.promise },
    process,
    scheduler,
    expectedPathNames: PATHS,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    probeController: new AbortController(),
  });
}

describe('MediaMTX readiness race quiescence', () => {
  it.each(['resolve', 'reject'] as const)('joins a late probe %s after timeout before rejecting', async (settlement) => {
    // Given
    const pending = deferredSnapshot();
    const scheduler = new ManualScheduler();
    const result = readiness(pending, new FakeProcess(), scheduler);
    await flushUntil(() => scheduler.count(STARTUP_TIMEOUT_MS) === 1);

    // When
    scheduler.advance(STARTUP_TIMEOUT_MS);
    await expectPending(result);
    if (settlement === 'resolve') pending.resolve(snapshot());
    else pending.reject(new MediaMtxApiClientError('REQUEST_FAILED'));

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError('STARTUP_TIMEOUT'));
  });

  it.each(['resolve', 'reject'] as const)('joins a late probe %s after process close before rejecting', async (settlement) => {
    // Given
    const pending = deferredSnapshot();
    const process = new FakeProcess();
    const result = readiness(pending, process, new ManualScheduler());

    // When
    process.finish({ code: 1, signal: null });
    await expectPending(result);
    if (settlement === 'resolve') pending.resolve(snapshot());
    else pending.reject(new MediaMtxApiClientError('REQUEST_FAILED'));

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError('PROCESS_EXITED'));
  });
});
