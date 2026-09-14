import { describe, expect, it } from 'vitest';
import {
  stopFfmpeg,
  stopMediaMtx,
  type ManagedProcessPort,
  type ManagedProcessStatus,
  type ProcessCloseStatus,
  type ProcessDiagnostics,
  type ProcessSignal,
  type ProcessSignalResult,
  type SchedulerPort,
} from '../src/index.js';

const cleanDiagnostics: ProcessDiagnostics = {
  stdoutBytes: 0,
  stderrBytes: 0,
  warningChunks: 0,
  errorChunks: 0,
  streamErrors: 0,
  progressQueuedBytes: 0,
  progressQueuedItems: 0,
  progressDroppedBytes: 0,
  progressDroppedItems: 0,
  progressCoalescedItems: 0,
  fd4DrainListeners: 0,
  fd4ErrorListeners: 0,
  fd4CloseListeners: 0,
};

class FakeProcess implements ManagedProcessPort {
  public readonly progress = null;
  public readonly signals: ProcessSignal[] = [];
  public readonly close: Promise<ProcessCloseStatus>;
  private closed: ProcessCloseStatus | null = null;
  private resolveClose: (status: ProcessCloseStatus) => void = () => undefined;

  public constructor(
    private readonly closeOn: ProcessSignal | null,
    private readonly failOn: ProcessSignal | null = null,
  ) {
    this.close = new Promise((resolve) => { this.resolveClose = resolve; });
  }

  public diagnostics = (): ProcessDiagnostics => cleanDiagnostics;
  public pumpFd4 = async (): Promise<void> => undefined;
  public signal = (signal: ProcessSignal): ProcessSignalResult => {
    if (this.closed !== null) return { state: 'alreadyClosed' };
    this.signals.push(signal);
    if (signal === this.failOn) return { state: 'failed' };
    if (signal === this.closeOn) this.finish({ code: null, signal });
    return { state: 'delivered' };
  };
  public status = (): ManagedProcessStatus => this.closed === null
    ? { state: 'running' }
    : { state: 'closed', close: this.closed };
  public releaseHandles = (): void => undefined;

  public finish(status: ProcessCloseStatus): void {
    if (this.closed !== null) return;
    this.closed = status;
    this.resolveClose(status);
  }
}

class ManualScheduler implements SchedulerPort {
  public readonly waits: number[] = [];
  private releases: Array<() => void> = [];

  public wait = (delayMs: number, signal: AbortSignal): Promise<void> => {
    void signal;
    this.waits.push(delayMs);
    return new Promise((resolve) => { this.releases.push(resolve); });
  };

  public advance(): void {
    this.releases.shift()?.();
  }
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForWaitCount(scheduler: ManualScheduler, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (scheduler.waits.length >= expected) return;
    await Promise.resolve();
  }
  throw new TypeError('Scheduler wait was not registered');
}

describe('managed process shutdown', () => {
  it('escalates FFmpeg from SIGTERM to SIGKILL and awaits close', async () => {
    const process = new FakeProcess('SIGKILL');
    const scheduler = new ManualScheduler();

    const stopped = stopFfmpeg({ process, scheduler, graceMs: 2000, signal: new AbortController().signal });
    await nextTurn();
    scheduler.advance();
    const close = await stopped;

    expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(scheduler.waits).toEqual([2000]);
    expect(close).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('escalates MediaMTX through all three signals when signals are ignored', async () => {
    const process = new FakeProcess('SIGKILL');
    const scheduler = new ManualScheduler();

    const stopped = stopMediaMtx({ process, scheduler, graceMs: 500, signal: new AbortController().signal });
    await waitForWaitCount(scheduler, 1);
    scheduler.advance();
    await waitForWaitCount(scheduler, 2);
    scheduler.advance();
    const close = await stopped;

    expect(process.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(scheduler.waits).toEqual([500, 500]);
    expect(close.signal).toBe('SIGKILL');
  });

  it('sends no later signal when close wins a grace period', async () => {
    const process = new FakeProcess('SIGTERM');
    const scheduler = new ManualScheduler();

    const close = await stopFfmpeg({ process, scheduler, graceMs: 1000, signal: new AbortController().signal });

    expect(process.signals).toEqual(['SIGTERM']);
    expect(close.signal).toBe('SIGTERM');
  });

  it('skips grace after abort but still signals and reaps', async () => {
    const process = new FakeProcess('SIGKILL');
    const scheduler = new ManualScheduler();
    const controller = new AbortController();
    controller.abort();

    const close = await stopFfmpeg({ process, scheduler, graceMs: 1000, signal: controller.signal });

    expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(close.signal).toBe('SIGKILL');
  });

  it('rejects without waiting when graceful signal delivery fails', async () => {
    const process = new FakeProcess(null, 'SIGTERM');
    const scheduler = new ManualScheduler();

    await expect(stopFfmpeg({
      process,
      scheduler,
      graceMs: 1000,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SIGNAL_FAILED' });
    expect(process.signals).toEqual(['SIGTERM']);
    expect(scheduler.waits).toEqual([]);
  });

  it('rejects without awaiting close when final signal delivery fails', async () => {
    const process = new FakeProcess(null, 'SIGKILL');
    const scheduler = new ManualScheduler();
    const stopped = stopFfmpeg({
      process,
      scheduler,
      graceMs: 1000,
      signal: new AbortController().signal,
    });
    await waitForWaitCount(scheduler, 1);
    scheduler.advance();

    await expect(stopped).rejects.toMatchObject({ code: 'SIGNAL_FAILED' });
    expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('aborts a pending grace and immediately escalates to reap', async () => {
    const process = new FakeProcess('SIGKILL');
    const scheduler = new ManualScheduler();
    const controller = new AbortController();
    const stopped = stopFfmpeg({ process, scheduler, graceMs: 1000, signal: controller.signal });
    await waitForWaitCount(scheduler, 1);
    controller.abort();

    expect(await stopped).toEqual({ code: null, signal: 'SIGKILL' });
    expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
