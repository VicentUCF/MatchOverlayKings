import { describe, expect, it } from 'vitest';
import { MediaMtxApiClientError } from '../src/mediamtx-api-client.js';
import {
  MediaMtxReadinessError,
  waitForMediaMtxReadiness,
} from '../src/mediamtx-readiness.js';
import {
  FakeApiClient,
  FakeProcess,
  ManualScheduler,
  PATHS,
  expectPending,
  flushUntil,
  snapshot,
} from './mediamtx-service-fixture.js';

const STARTUP_TIMEOUT_MS = 10_000;

function readiness(client: FakeApiClient, process: FakeProcess, scheduler: ManualScheduler) {
  return waitForMediaMtxReadiness({
    client,
    process,
    scheduler,
    expectedPathNames: PATHS,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    probeController: new AbortController(),
  });
}

describe('MediaMTX readiness policy', () => {
  it('succeeds only for the exact four configured paths while preserving immutable statuses', async () => {
    // Given
    const client = new FakeApiClient([snapshot()]);
    const process = new FakeProcess();
    const scheduler = new ManualScheduler();

    // When
    const result = await readiness(client, process, scheduler);

    // Then
    expect(result).toEqual(snapshot());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(result.items.some(({ available, online }) => !available && !online)).toBe(true);
  });

  it.each(['REQUEST_FAILED', 'SERVER_ERROR'] as const)('retries %s then succeeds', async (code) => {
    // Given
    const client = new FakeApiClient([new MediaMtxApiClientError(code), snapshot()]);
    const process = new FakeProcess();
    const scheduler = new ManualScheduler();

    // When
    const result = readiness(client, process, scheduler);
    await flushUntil(() => scheduler.waits.length >= 2);
    const retry = scheduler.waits.find(({ delayMs }) => delayMs !== STARTUP_TIMEOUT_MS);
    if (retry === undefined) throw new TypeError('Expected readiness retry');
    expect(retry.delayMs).toBeLessThanOrEqual(100);
    retry.resolve();

    // Then
    await expect(result).resolves.toEqual(snapshot());
    expect(client.calls).toBe(2);
  });

  it('retries a wrong valid path set until the operation-wide timeout', async () => {
    // Given
    const client = new FakeApiClient([snapshot(['court-1', 'court-2', 'court-3', 'other'])]);
    const process = new FakeProcess();
    const scheduler = new ManualScheduler();

    // When
    const result = readiness(client, process, scheduler);
    await flushUntil(() => scheduler.count(STARTUP_TIMEOUT_MS) === 1);
    scheduler.advance(STARTUP_TIMEOUT_MS);

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError('STARTUP_TIMEOUT'));
  });

  it.each([
    { itemCount: 5, pageCount: 2 },
    { itemCount: 4, pageCount: 2 },
  ])('does not accept an incomplete page with exact names ($itemCount items, $pageCount pages)', async (counts) => {
    // Given
    const client = new FakeApiClient([snapshot(PATHS, counts.itemCount, counts.pageCount)]);
    const scheduler = new ManualScheduler();
    const result = readiness(client, new FakeProcess(), scheduler);
    await flushUntil(() => scheduler.count(STARTUP_TIMEOUT_MS) === 1);

    // When
    scheduler.advance(STARTUP_TIMEOUT_MS);

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError('STARTUP_TIMEOUT'));
  });

  it.each([
    'AUTH_FAILED',
    'HTTP_ERROR',
    'MALFORMED_RESPONSE',
    'RESPONSE_TOO_LARGE',
    'CREDENTIAL_DISPOSED',
    'CONFIG_INVALID',
  ] as const)('fails immediately on terminal client error %s', async (code) => {
    // Given
    const client = new FakeApiClient([new MediaMtxApiClientError(code)]);
    const scheduler = new ManualScheduler();

    // When
    const result = readiness(client, new FakeProcess(), scheduler);

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError(code));
    expect(scheduler.waits.filter(({ delayMs }) => delayMs !== STARTUP_TIMEOUT_MS)).toEqual([]);
  });

  it('aborts a blocked probe and fails when the process exits before readiness', async () => {
    // Given
    let aborted = false;
    let calls = 0;
    const blockedClient = {
      listPaths: (signal: AbortSignal) => {
        calls += 1;
        return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
            reject(new MediaMtxApiClientError('ABORTED'));
        }, { once: true });
        });
      },
    };
    const process = new FakeProcess();
    const result = waitForMediaMtxReadiness({
      client: blockedClient,
      process,
      scheduler: new ManualScheduler(),
      expectedPathNames: PATHS,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      probeController: new AbortController(),
    });
    await flushUntil(() => calls === 1);

    // When
    process.finish({ code: 1, signal: null });

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError('PROCESS_EXITED'));
    expect(aborted).toBe(true);
  });

  it('remains pending without scheduler advancement or process close', async () => {
    // Given
    const client = new FakeApiClient([new MediaMtxApiClientError('REQUEST_FAILED')]);
    const result = readiness(client, new FakeProcess(), new ManualScheduler());

    // When / Then
    await expectPending(result);
  });

  it('bounds a blocked HTTP probe by the operation-wide scheduler timeout', async () => {
    // Given
    let aborted = false;
    const scheduler = new ManualScheduler();
    const result = waitForMediaMtxReadiness({
      client: {
        listPaths: (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new MediaMtxApiClientError('ABORTED'));
          }, { once: true });
        }),
      },
      process: new FakeProcess(),
      scheduler,
      expectedPathNames: PATHS,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      probeController: new AbortController(),
    });
    await flushUntil(() => scheduler.count(STARTUP_TIMEOUT_MS) === 1);

    // When
    scheduler.advance(STARTUP_TIMEOUT_MS);

    // Then
    await expect(result).rejects.toEqual(new MediaMtxReadinessError('STARTUP_TIMEOUT'));
    expect(aborted).toBe(true);
  });
});
