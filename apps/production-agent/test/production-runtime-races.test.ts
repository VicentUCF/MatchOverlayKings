import { describe, expect, it } from 'vitest';
import {
  CourtSnapshotSchema,
  ObservedStateProjector,
  ProductionAgentLifecycle,
  ProductionAgentShutdownDeadlineError,
  ProductionReconciliationError,
  ProductionReconciliationLoop,
  ProfileFingerprintSchema,
  type CourtWorkerResult,
  type ProductionSignal,
  type ProductionSignalSource,
  type SupervisorSnapshots,
} from '../src/index.js';
import { runningSnapshots } from './supervisor-fixtures.js';

function snapshots(): SupervisorSnapshots {
  const raw = runningSnapshots();
  return [
    CourtSnapshotSchema.parse(raw[0]),
    CourtSnapshotSchema.parse(raw[1]),
    CourtSnapshotSchema.parse(raw[2]),
    CourtSnapshotSchema.parse(raw[3]),
  ];
}

function reconciled(): readonly CourtWorkerResult[] {
  const fingerprint = ProfileFingerprintSchema.parse('b'.repeat(64));
  return snapshots().map((snapshot) => ({
    kind: 'reconciled',
    courtId: snapshot.output.courtId,
    reconciliation: {
      outputId: snapshot.output.id,
      desiredVersion: snapshot.desired.version,
      desiredProfileFingerprint: fingerprint,
      action: { kind: 'noop', reason: 'runtime-healthy' },
    },
    runtime: {
      outputId: snapshot.output.id,
      appliedDesiredVersion: snapshot.desired.version,
      profileFingerprint: fingerprint,
    },
  }));
}

function createLoop(
  list: (signal: AbortSignal) => Promise<readonly never[]>,
  load: (signal: AbortSignal) => Promise<readonly ReturnType<typeof snapshots>[number][]>,
  reconcile: (input: SupervisorSnapshots) => Promise<{ readonly courts: readonly CourtWorkerResult[] }>,
): ProductionReconciliationLoop {
  const current = snapshots();
  return new ProductionReconciliationLoop({
    controlPlane: {
      listClaimableOperations: (_limit, signal) => list(signal),
      claimOperation: async () => { throw new TypeError('Unexpected claim'); },
      loadAssignedOutputSnapshots: load,
      reportObservedState: async () => ({}),
      completeOperation: async () => { throw new TypeError('Unexpected completion'); },
    },
    supervisor: { reconcile },
    projector: new ObservedStateProjector(),
    scheduler: { wait: async () => undefined },
    clock: { nowMs: () => 0 },
    logger: { log: () => undefined },
    courtIds: [
      current[0].output.courtId,
      current[1].output.courtId,
      current[2].output.courtId,
      current[3].output.courtId,
    ],
    pollIntervalMs: 1_000,
  });
}

describe('production reconciliation boundaries', () => {
  it('serializes concurrently requested cycles', async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const entered: (() => void)[] = [];
    const firstEntered = new Promise<void>((resolve) => { entered.push(resolve); });
    const secondEntered = new Promise<void>((resolve) => { entered.push(resolve); });
    const list = async (): Promise<readonly never[]> => {
      active += 1;
      peak = Math.max(peak, active);
      entered.shift()?.();
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active -= 1;
      return [];
    };
    const loop = createLoop(list, async () => snapshots(), async () => ({ courts: reconciled() }));

    const first = loop.runCycle(new AbortController().signal);
    const second = loop.runCycle(new AbortController().signal);
    await firstEntered;
    releases.shift()?.();
    await secondEntered;
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(peak).toBe(1);
  });

  it('rejects an incomplete court mapping before reconciliation', async () => {
    let reconciliations = 0;
    const current = snapshots();
    const loop = createLoop(async () => [], async () => current.slice(0, 3), async () => {
      reconciliations += 1;
      return { courts: reconciled() };
    });

    const round = loop.runCycle(new AbortController().signal);

    await expect(round).rejects.toBeInstanceOf(ProductionReconciliationError);
    expect(reconciliations).toBe(0);
  });
});

class ManualSignals implements ProductionSignalSource {
  private listener: ((signal: ProductionSignal) => void) | null = null;
  public subscribe(listener: (signal: ProductionSignal) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  public emit(): void { this.listener?.('SIGINT'); }
}

const noopHardExit: (code: 1) => void = () => undefined;

describe('production shutdown races', () => {
  it('treats a signal during MediaMTX startup as graceful shutdown', async () => {
    const signals = new ManualSignals();
    let rejectStart: (reason: Error) => void = () => undefined;
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: {
        start: () => new Promise((_resolve, reject) => { rejectStart = reject; }),
        stop: async () => undefined,
      },
      supervisor: { shutdown: async () => ({ courts: [] }) },
      loop: { run: async () => undefined },
      scheduler: { wait: (_delay, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
      signals,
      logger: { log: () => undefined },
      shutdownDeadlineMs: 5_000,
      hardExit: noopHardExit,
    });
    const running = lifecycle.run();
    await Promise.resolve();

    signals.emit();
    rejectStart(new Error('startup aborted'));

    await expect(running).resolves.toBeUndefined();
  });

  it('shares cleanup across repeated signals', async () => {
    const signals = new ManualSignals();
    let shutdowns = 0;
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: { start: async () => undefined, stop: async () => undefined },
      supervisor: { shutdown: async () => { shutdowns += 1; return { courts: [] }; } },
      loop: { run: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
      scheduler: { wait: (_delay, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
      signals,
      logger: { log: () => undefined },
      shutdownDeadlineMs: 5_000,
      hardExit: noopHardExit,
    });
    const running = lifecycle.run();
    await Promise.resolve();

    signals.emit();
    signals.emit();
    await running;

    expect(shutdowns).toBe(1);
  });

  it('rejects cleanup when the shutdown deadline elapses', async () => {
    const signals = new ManualSignals();
    let elapse: () => void = () => undefined;
    const hardExitCodes: number[] = [];
    const events: string[] = [];
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: { start: async () => undefined, stop: async () => undefined },
      supervisor: { shutdown: () => new Promise(() => undefined) },
      loop: { run: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
      scheduler: { wait: () => new Promise((resolve) => { elapse = resolve; }) },
      signals,
      logger: { log: (_level, event) => { events.push(event); } },
      shutdownDeadlineMs: 5_000,
      hardExit: (code) => { hardExitCodes.push(code); },
    });
    const running = lifecycle.run();
    await Promise.resolve();
    signals.emit();
    signals.emit();

    elapse();

    await expect(running).rejects.toBeInstanceOf(ProductionAgentShutdownDeadlineError);
    expect(hardExitCodes).toEqual([1]);
    expect(events).not.toContain('agent_stopped');
  });

  it('hard exits when MediaMTX cleanup exceeds the shutdown deadline', async () => {
    const signals = new ManualSignals();
    let elapse: () => void = () => undefined;
    let mediaStopStarted: () => void = () => undefined;
    const mediaStopped = new Promise<void>((resolve) => { mediaStopStarted = resolve; });
    const hardExitCodes: number[] = [];
    const events: string[] = [];
    const lifecycle = new ProductionAgentLifecycle({
      mediaService: {
        start: async () => undefined,
        stop: () => {
          mediaStopStarted();
          return new Promise(() => undefined);
        },
      },
      supervisor: { shutdown: async () => ({ courts: [] }) },
      loop: { run: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
      scheduler: { wait: () => new Promise((resolve) => { elapse = resolve; }) },
      signals,
      logger: { log: (_level, event) => { events.push(event); } },
      shutdownDeadlineMs: 5_000,
      hardExit: (code) => { hardExitCodes.push(code); },
    });
    const running = lifecycle.run();
    await Promise.resolve();
    signals.emit();
    await mediaStopped;

    elapse();

    await expect(running).rejects.toBeInstanceOf(ProductionAgentShutdownDeadlineError);
    expect(hardExitCodes).toEqual([1]);
    expect(events).not.toContain('agent_stopped');
  });
});
