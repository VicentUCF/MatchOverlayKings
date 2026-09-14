import { describe, expect, it } from 'vitest';
import {
  ObservedStateProjector,
  ProductionAgentLifecycle,
  ProductionReconciliationError,
  ProductionReconciliationLoop,
  type ProductionSignal,
  type ProductionSignalSource,
  type SchedulerPort,
} from '../src/index.js';
import {
  loopFor,
  reconciledResults,
  silentLogger,
  snapshots,
} from './production-runtime-fixtures.js';

class ManualSignalSource implements ProductionSignalSource {
  private listener: ((signal: ProductionSignal) => void) | null = null;
  public subscribe(listener: (signal: ProductionSignal) => void): () => void { this.listener = listener; return () => { this.listener = null; }; }
  public emit(): void { this.listener?.('SIGTERM'); }
}

const noopHardExit: (code: 1) => void = () => undefined;

describe('production agent lifecycle', () => {
  it('stops pipelines without retrying a structurally invalid snapshot row', async () => {
    const calls: string[] = [];
    let retryWaits = 0;
    const current = snapshots();
    const invalid = structuredClone(current[0]);
    Reflect.deleteProperty(invalid.output, 'id');
    const supervisor = {
      reconcile: async () => ({ courts: reconciledResults(current) }),
      shutdown: async () => { calls.push('pipelines:stop'); return { courts: [] }; },
    };
    const loop = new ProductionReconciliationLoop({
      controlPlane: {
        loadAssignedOutputSnapshots: async () => [invalid, current[1], current[2], current[3]],
        listClaimableOperations: async () => [],
        claimOperation: async () => { throw new TypeError('Unexpected claim'); },
        reportObservedState: async () => ({}),
        completeOperation: async () => { throw new TypeError('Unexpected completion'); },
      },
      supervisor,
      projector: new ObservedStateProjector(),
      scheduler: {
        wait: async () => {
          retryWaits += 1;
          throw new TypeError('Invalid snapshot was retried');
        },
      },
      clock: { nowMs: () => 100 },
      logger: silentLogger(),
      courtIds: [current[0].output.courtId, current[1].output.courtId, current[2].output.courtId, current[3].output.courtId],
      pollIntervalMs: 1_000,
    });
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: {
        start: async () => { calls.push('media:start'); },
        stop: async () => { calls.push('media:stop'); },
      },
      supervisor,
      loop,
      scheduler: {
        wait: (_delay, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      },
      signals: new ManualSignalSource(),
      logger: silentLogger(),
      shutdownDeadlineMs: 5_000,
      hardExit: noopHardExit,
    });

    const running = lifecycle.run();

    await expect(running).rejects.toBeInstanceOf(ProductionReconciliationError);
    expect(calls).toEqual(['media:start', 'pipelines:stop', 'media:stop']);
    expect(retryWaits).toBe(0);
  });

  it('stops pipelines when a fatal reconciliation error escapes the polling loop', async () => {
    const calls: string[] = [];
    let retryWaits = 0;
    const current = snapshots();
    const supervisor = {
      reconcile: async () => ({ courts: [] }),
      shutdown: async () => { calls.push('pipelines:stop'); return { courts: [] }; },
    };
    const loop = loopFor({
      current,
      operations: [],
      reconcile: supervisor.reconcile,
      completeOperation: async () => { throw new TypeError('Unexpected completion'); },
      scheduler: {
        wait: async () => {
          retryWaits += 1;
          throw new TypeError('Fatal reconciliation was retried');
        },
      },
    });
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: {
        start: async () => { calls.push('media:start'); },
        stop: async () => { calls.push('media:stop'); },
      },
      supervisor,
      loop,
      scheduler: {
        wait: (_delay, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      },
      signals: new ManualSignalSource(),
      logger: silentLogger(),
      shutdownDeadlineMs: 5_000,
      hardExit: noopHardExit,
    });

    const running = lifecycle.run();

    await expect(running).rejects.toBeInstanceOf(ProductionReconciliationError);
    expect(calls).toEqual(['media:start', 'pipelines:stop', 'media:stop']);
    expect(retryWaits).toBe(0);
  });

  it('starts MediaMTX before polling and stops pipelines before MediaMTX on a signal', async () => {
    const calls: string[] = [];
    let hardExitCalls = 0;
    const signals = new ManualSignalSource();
    const scheduler: SchedulerPort = { wait: (_delay, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) };
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: { start: async () => { calls.push('media:start'); }, stop: async () => { calls.push('media:stop'); } },
      supervisor: { shutdown: async () => { calls.push('supervisor:shutdown'); return { courts: [] }; } },
      loop: { run: async (signal) => { calls.push('loop:run'); await scheduler.wait(60_000, signal); } },
      scheduler,
      signals,
      logger: silentLogger(),
      shutdownDeadlineMs: 5_000,
      hardExit: () => { hardExitCalls += 1; },
    });
    const running = lifecycle.run();
    await Promise.resolve();
    await Promise.resolve();

    signals.emit();
    await running;

    expect(calls).toEqual(['media:start', 'loop:run', 'supervisor:shutdown', 'media:stop']);
    expect(hardExitCalls).toBe(0);
  });
});
