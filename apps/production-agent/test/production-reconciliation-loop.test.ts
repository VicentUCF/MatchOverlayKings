import {
  OperationClaimSchema,
  OperationSchema,
  type CompleteOperationCommand,
  type Operation,
  type ReportObservedStateCommand,
} from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import {
  CourtSnapshotSchema,
  ObservedStateProjector,
  ProductionReconciliationLoop,
  type CourtSnapshot,
  type SupervisorSnapshots,
} from '../src/index.js';
import {
  claimFor,
  loopFor,
  offlineResult,
  operationFor,
  reconciledResult,
  reconciledResults,
  settledClaimFor,
  silentLogger,
  snapshots,
  withFirstLifecycle,
} from './production-runtime-fixtures.js';
import { COURT_IDS, OUTPUT_IDS, runningSnapshots } from './supervisor-fixtures.js';

describe('production reconciliation loop', () => {
  it('uses the snapshot as intent and completes a claim only after all reports', async () => {
    const calls: string[] = [];
    const reports: ReportObservedStateCommand[] = [];
    const completions: CompleteOperationCommand[] = [];
    const operation = operationFor(snapshots()[0]);
    const claim = claimFor(operation);
    const loop = new ProductionReconciliationLoop({
      controlPlane: {
        listClaimableOperations: async (limit, signal) => { calls.push(`list:${limit}:${signal.aborted}`); return [operation]; },
        claimOperation: async (_id, lease, signal) => { calls.push(`claim:${lease}:${signal.aborted}`); return claim; },
        loadAssignedOutputSnapshots: async (signal) => { calls.push(`snapshot:${signal.aborted}`); return [...snapshots()].reverse(); },
        reportObservedState: async (command, signal) => {
          calls.push(`report:${command.outputId}:${signal.aborted}`); reports.push(command);
          const snapshot = runningSnapshots().find(({ output }) => output.id === command.outputId);
          if (snapshot === undefined) throw new TypeError('Unknown output fixture');
          return { ...snapshot.observed, ...command };
        },
        completeOperation: async (command, signal) => {
          calls.push(`complete:${signal.aborted}`); completions.push(command);
          return OperationClaimSchema.parse({ ...claim, status: command.status, result: command.result, completedAt: '2026-09-10T08:03:00Z' });
        },
      },
      supervisor: { reconcile: async (ordered) => { calls.push(`reconcile:${ordered[0].output.courtId}`); return { courts: reconciledResults() }; } },
      projector: new ObservedStateProjector(), scheduler: { wait: async () => undefined },
      clock: { nowMs: () => 100 }, logger: silentLogger(),
      courtIds: [snapshots()[0].output.courtId, snapshots()[1].output.courtId, snapshots()[2].output.courtId, snapshots()[3].output.courtId],
      pollIntervalMs: 1_000,
    });

    await loop.runCycle(new AbortController().signal);

    expect(calls[0]).toBe('snapshot:false');
    expect(calls).toContain('claim:300:false');
    expect(calls).toContain(`reconcile:${COURT_IDS[0]}`);
    expect(reports).toHaveLength(4);
    expect(calls.findIndex((call) => call.startsWith('complete'))).toBeGreaterThan(calls.findLastIndex((call) => call.startsWith('report')));
    expect(completions).toEqual([{ operationId: operation.id, status: 'completed', result: { summary: 'Reconciliation applied', retryable: false } }]);
  });

  it.each([
    ['missing', (current: SupervisorSnapshots): readonly CourtSnapshot[] => current.slice(0, 3)],
    ['duplicate', (current: SupervisorSnapshots): readonly CourtSnapshot[] => [current[0], current[1], current[2], current[2]]],
    ['malformed', (current: SupervisorSnapshots): readonly CourtSnapshot[] => [...current, current[0]]],
  ])('rejects %s topology before listing or claiming operations', async (_kind, topology) => {
    let listings = 0;
    let claims = 0;
    const current = snapshots();
    const operation = operationFor(current[0]);
    const loop = new ProductionReconciliationLoop({
      controlPlane: {
        loadAssignedOutputSnapshots: async () => topology(current),
        listClaimableOperations: async () => { listings += 1; return [operation]; },
        claimOperation: async () => { claims += 1; return claimFor(operation); },
        reportObservedState: async () => ({}),
        completeOperation: async () => claimFor(operation),
      },
      supervisor: { reconcile: async () => ({ courts: reconciledResults() }) },
      projector: new ObservedStateProjector(), scheduler: { wait: async () => undefined },
      clock: { nowMs: () => 100 }, logger: silentLogger(),
      courtIds: [current[0].output.courtId, current[1].output.courtId, current[2].output.courtId, current[3].output.courtId],
      pollIntervalMs: 1_000,
    });

    const round = loop.runCycle(new AbortController().signal);

    await expect(round).rejects.toMatchObject({ code: 'INVALID_ROUND' });
    expect({ listings, claims }).toEqual({ listings: 0, claims: 0 });
  });

  it.each([
    ['command', (operation: Operation): Operation => operation],
    ['output', (operation: Operation): Operation => OperationSchema.parse({ ...operation, outputId: OUTPUT_IDS[1] })],
    ['court', (operation: Operation): Operation => OperationSchema.parse({ ...operation, courtId: COURT_IDS[1] })],
  ])('terminally fails a claimed operation with superseded %s identity', async (kind, supersede) => {
    const prior = snapshots();
    const operation = supersede(operationFor(prior[0]));
    const current: SupervisorSnapshots = kind === 'command'
      ? [CourtSnapshotSchema.parse({
        ...prior[0],
        desired: { ...prior[0].desired, version: prior[0].desired.version + 1, commandId: 'newer-command' },
      }), prior[1], prior[2], prior[3]]
      : prior;
    const claim = claimFor(operation);
    const completions: CompleteOperationCommand[] = [];
    const loop = new ProductionReconciliationLoop({
      controlPlane: {
        loadAssignedOutputSnapshots: async () => current,
        listClaimableOperations: async () => [operation],
        claimOperation: async () => claim,
        reportObservedState: async () => ({}),
        completeOperation: async (command) => {
          completions.push(command);
          return OperationClaimSchema.parse({ ...claim, status: command.status, result: command.result, completedAt: '2026-09-10T08:03:00Z' });
        },
      },
      supervisor: { reconcile: async () => ({ courts: reconciledResults() }) },
      projector: new ObservedStateProjector(), scheduler: { wait: async () => undefined },
      clock: { nowMs: () => 100 }, logger: silentLogger(),
      courtIds: [current[0].output.courtId, current[1].output.courtId, current[2].output.courtId, current[3].output.courtId],
      pollIntervalMs: 1_000,
    });

    await loop.runCycle(new AbortController().signal);

    expect(completions).toEqual([{
      operationId: operation.id,
      status: 'failed',
      result: { summary: 'Operation superseded', retryable: false },
    }]);
  });

  it.each([
    ['preflight', 'healthy', { status: 'completed', result: { summary: 'Reconciliation applied', retryable: false } }],
    ['running', 'offline', { status: 'failed', result: { summary: 'Reconciliation failed', retryable: true } }],
    ['off', 'offline', { status: 'completed', result: { summary: 'Reconciliation applied', retryable: false } }],
    ['stopped', 'healthy', { status: 'failed', result: { summary: 'Reconciliation failed', retryable: true } }],
  ] as const)('settles %s desired state from %s health', async (lifecycle, health, expected) => {
    const current = withFirstLifecycle(snapshots(), lifecycle);
    const operation = operationFor(current[0]);
    const completions: CompleteOperationCommand[] = [];
    const loop = loopFor({
      current,
      operations: [operation],
      reconcile: async () => ({
        courts: current.map((snapshot, index) =>
          index === 0 && health === 'offline' ? offlineResult(snapshot) : reconciledResult(snapshot)),
      }),
      completeOperation: async (command) => {
        completions.push(command);
        return settledClaimFor(operation, command);
      },
    });

    await loop.runCycle(new AbortController().signal);

    expect(completions).toEqual([{ operationId: operation.id, ...expected }]);
  });
});
