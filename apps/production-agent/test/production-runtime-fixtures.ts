import {
  OperationClaimSchema,
  OperationSchema,
  type CompleteOperationCommand,
  type Operation,
} from '@kpl/production-contracts';
import {
  CourtSnapshotSchema,
  ObservedStateProjector,
  ProductionReconciliationLoop,
  ProfileFingerprintSchema,
  type AgentLogger,
  type CourtSnapshot,
  type CourtWorkerResult,
  type ReconciliationControlPlanePort,
  type ReconciliationSupervisorPort,
  type SchedulerPort,
  type SupervisorSnapshots,
} from '../src/index.js';
import { runningSnapshots } from './supervisor-fixtures.js';

const FINGERPRINT = ProfileFingerprintSchema.parse('a'.repeat(64));

export function snapshots(): SupervisorSnapshots {
  const raw = runningSnapshots();
  return [
    CourtSnapshotSchema.parse(raw[0]),
    CourtSnapshotSchema.parse(raw[1]),
    CourtSnapshotSchema.parse(raw[2]),
    CourtSnapshotSchema.parse(raw[3]),
  ];
}

export function reconciledResult(snapshot: CourtSnapshot): CourtWorkerResult {
  return {
    kind: 'reconciled',
    courtId: snapshot.output.courtId,
    reconciliation: {
      outputId: snapshot.output.id,
      desiredVersion: snapshot.desired.version,
      desiredProfileFingerprint: FINGERPRINT,
      action: { kind: 'start', reason: 'runtime-absent', target: {
        output: snapshot.output,
        desired: snapshot.desired,
        profileFingerprint: FINGERPRINT,
      } },
    },
    runtime: {
      outputId: snapshot.output.id,
      appliedDesiredVersion: snapshot.desired.version,
      profileFingerprint: FINGERPRINT,
    },
  };
}

export function reconciledResults(current: SupervisorSnapshots = snapshots()): readonly CourtWorkerResult[] {
  return current.map(reconciledResult);
}

export function offlineResult(snapshot: CourtSnapshot): CourtWorkerResult {
  return {
    kind: 'reconciled',
    courtId: snapshot.output.courtId,
    reconciliation: {
      outputId: snapshot.output.id,
      desiredVersion: snapshot.desired.version,
      desiredProfileFingerprint: FINGERPRINT,
      action: { kind: 'noop', reason: 'desired-inactive' },
    },
    runtime: null,
  };
}

export function silentLogger(): AgentLogger {
  return { log: () => undefined };
}

export function operationFor(snapshot: CourtSnapshot): Operation {
  return OperationSchema.parse({
    id: '81000000-0000-4000-8000-000000000001',
    clubId: snapshot.output.clubId,
    eventId: snapshot.output.eventId,
    courtId: snapshot.output.courtId,
    outputId: snapshot.output.id,
    commandId: snapshot.desired.commandId,
    kind: 'stop',
    payload: {},
    requestedByPrincipalId: snapshot.desired.updatedByPrincipalId,
    createdAt: '2026-09-10T08:02:00Z',
  });
}

export function claimFor(operation: Operation) {
  return OperationClaimSchema.parse({
    operationId: operation.id,
    agentPrincipalId: operation.requestedByPrincipalId,
    status: 'claimed',
    claimedAt: '2026-09-10T08:02:01Z',
    leaseExpiresAt: '2026-09-10T08:07:01Z',
    result: null,
    completedAt: null,
  });
}

export function settledClaimFor(operation: Operation, command: CompleteOperationCommand) {
  return OperationClaimSchema.parse({
    ...claimFor(operation),
    status: command.status,
    result: command.result,
    completedAt: '2026-09-10T08:03:00Z',
  });
}

type LoopFixture = {
  readonly current: SupervisorSnapshots;
  readonly operations: readonly Operation[];
  readonly reconcile: ReconciliationSupervisorPort['reconcile'];
  readonly completeOperation: ReconciliationControlPlanePort['completeOperation'];
  readonly reportObservedState?: ReconciliationControlPlanePort['reportObservedState'];
  readonly scheduler?: SchedulerPort;
};

export function loopFor(input: LoopFixture): ProductionReconciliationLoop {
  return new ProductionReconciliationLoop({
    controlPlane: {
      loadAssignedOutputSnapshots: async () => input.current,
      listClaimableOperations: async () => input.operations,
      claimOperation: async (operationId) => {
        const operation = input.operations.find(({ id }) => id === operationId);
        if (operation === undefined) throw new TypeError('Unknown operation fixture');
        return claimFor(operation);
      },
      reportObservedState: input.reportObservedState ?? (async () => ({})),
      completeOperation: input.completeOperation,
    },
    supervisor: { reconcile: input.reconcile },
    projector: new ObservedStateProjector(),
    scheduler: input.scheduler ?? { wait: async () => undefined },
    clock: { nowMs: () => 100 },
    logger: silentLogger(),
    courtIds: [
      input.current[0].output.courtId,
      input.current[1].output.courtId,
      input.current[2].output.courtId,
      input.current[3].output.courtId,
    ],
    pollIntervalMs: 1_000,
  });
}

export function withFirstLifecycle(
  current: SupervisorSnapshots,
  lifecycle: CourtSnapshot['desired']['desired']['lifecycle'],
): SupervisorSnapshots {
  return [CourtSnapshotSchema.parse({
    ...current[0],
    desired: {
      ...current[0].desired,
      desired: { ...current[0].desired.desired, lifecycle },
    },
  }), current[1], current[2], current[3]];
}

export function operationsForFirstTwo(current: SupervisorSnapshots): readonly [Operation, Operation] {
  return [
    operationFor(current[0]),
    OperationSchema.parse({
      ...operationFor(current[1]),
      id: '81000000-0000-4000-8000-000000000002',
    }),
  ];
}
