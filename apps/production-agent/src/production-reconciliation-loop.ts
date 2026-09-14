import {
  type CourtId,
  type CompleteOperationCommand,
  type Operation,
  type OperationClaim,
  type OperationId,
  type ReportObservedStateCommand,
} from '@kpl/production-contracts';
import type { AgentLogger } from './agent-logger.js';
import { ControlPlaneAdapterError } from './control-plane.js';
import { CourtSnapshotSchema, type CourtSnapshot, type SupervisorSnapshots } from './config.js';
import type { ObservedStateProjector } from './observed-state-projection.js';
import type { SupervisorReconciliationResult, SupervisorShutdownResult } from './orchestration-models.js';
import type { SchedulerPort } from './process-stop.js';
import { SerializedTaskQueue } from './serialized-task-queue.js';

const OPERATION_BATCH_SIZE = 32;
const OPERATION_LEASE_SECONDS = 300;

type FourCourtIds = readonly [CourtId, CourtId, CourtId, CourtId];

export interface ReconciliationControlPlanePort {
  readonly loadAssignedOutputSnapshots: (signal: AbortSignal) => Promise<unknown>;
  readonly listClaimableOperations: (limit: number, signal: AbortSignal) => Promise<readonly Operation[]>;
  readonly claimOperation: (operationId: OperationId, leaseSeconds: number, signal: AbortSignal) => Promise<OperationClaim>;
  readonly completeOperation: (command: CompleteOperationCommand, signal: AbortSignal) => Promise<OperationClaim>;
  readonly reportObservedState: (command: ReportObservedStateCommand, signal: AbortSignal) => Promise<unknown>;
}

export interface ReconciliationSupervisorPort {
  readonly reconcile: (snapshots: SupervisorSnapshots) => Promise<SupervisorReconciliationResult>;
  readonly shutdown?: () => Promise<SupervisorShutdownResult>;
}

export type ProductionReconciliationLoopOptions = {
  readonly controlPlane: ReconciliationControlPlanePort;
  readonly supervisor: ReconciliationSupervisorPort;
  readonly projector: ObservedStateProjector;
  readonly scheduler: SchedulerPort;
  readonly clock: { readonly nowMs: () => number };
  readonly logger: AgentLogger;
  readonly courtIds: FourCourtIds;
  readonly pollIntervalMs: number;
};

export class ProductionReconciliationError extends Error {
  public readonly code = 'INVALID_ROUND' as const;

  public constructor() {
    super('Invalid production reconciliation round');
    this.name = 'ProductionReconciliationError';
  }
}

export class ProductionReconciliationLoop {
  private readonly queue = new SerializedTaskQueue();
  private readonly outputHealth = new Map<CourtId, ReportObservedStateCommand['health']>();
  private attempt = 0;
  private snapshotKey: string | null = null;

  public constructor(private readonly options: ProductionReconciliationLoopOptions) {}

  public runCycle(signal: AbortSignal): Promise<void> {
    return this.queue.run(() => this.executeCycle(signal));
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runCycle(signal);
        this.attempt = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProductionReconciliationError) throw error;
        this.attempt = Math.min(this.attempt + 1, 100);
        this.options.logger.log('error', 'agent_error', {
          errorCode: error instanceof ControlPlaneAdapterError ? error.code : 'REQUEST_FAILED',
        });
        this.options.logger.log('warn', 'retry_scheduled', { attempt: this.attempt });
      }
      await this.options.scheduler.wait(this.options.pollIntervalMs, signal);
    }
  }

  private async executeCycle(signal: AbortSignal): Promise<void> {
    const startedAt = this.options.clock.nowMs();
    const loaded = await this.options.controlPlane.loadAssignedOutputSnapshots(signal);
    throwIfAborted(signal);
    const snapshots = orderSnapshots(loaded, this.options.courtIds);
    const snapshotKey = snapshots.map((snapshot) => `${snapshot.output.id}:${snapshot.desired.version}`).join('|');
    if (snapshotKey !== this.snapshotKey) {
      this.snapshotKey = snapshotKey;
      this.options.logger.log('info', 'snapshot_loaded', {
        durationMs: Math.max(0, this.options.clock.nowMs() - startedAt),
      });
    }
    const operations = await this.options.controlPlane.listClaimableOperations(OPERATION_BATCH_SIZE, signal);
    throwIfAborted(signal);
    const claims: OperationClaim[] = [];
    for (const operation of operations) {
      const claim = await this.options.controlPlane.claimOperation(operation.id, OPERATION_LEASE_SECONDS, signal);
      throwIfAborted(signal);
      if (claim.status === 'claimed') {
        claims.push(claim);
        this.options.logger.log('info', 'operation_claimed', { operationId: claim.operationId });
      }
    }
    const settledClaimIds = new Set<OperationId>();
    try {
      const reconciliation = await this.options.supervisor.reconcile(snapshots);
      throwIfAborted(signal);
      if (reconciliation.courts.length !== snapshots.length) throw new ProductionReconciliationError();
      const reports = new Map<CourtId, ReportObservedStateCommand>();
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        const result = reconciliation.courts[index];
        if (snapshot === undefined || result === undefined || result.courtId !== snapshot.output.courtId) {
          throw new ProductionReconciliationError();
        }
        const command = this.options.projector.project(snapshot, result);
        await this.options.controlPlane.reportObservedState(command, signal);
        throwIfAborted(signal);
        reports.set(snapshot.output.courtId, command);
        if (this.outputHealth.get(snapshot.output.courtId) !== command.health) {
          this.outputHealth.set(snapshot.output.courtId, command.health);
          this.options.logger.log('info', 'output_health', {
            courtId: snapshot.output.courtId,
            outputId: snapshot.output.id,
            desiredVersion: snapshot.desired.version,
            health: command.health,
          });
        }
      }
      for (const claim of claims) {
        const operation = operations.find(({ id }) => id === claim.operationId);
        if (operation === undefined) throw new ProductionReconciliationError();
        const completion = operationCompletion(operation, snapshots, reports);
        await this.options.controlPlane.completeOperation(completion, signal);
        settledClaimIds.add(claim.operationId);
        throwIfAborted(signal);
        this.options.logger.log('info', 'operation_completed', { operationId: claim.operationId });
      }
    } catch (error) {
      await this.failUnsettledClaims(claims, settledClaimIds, signal);
      throw error;
    }
  }

  private async failUnsettledClaims(
    claims: readonly OperationClaim[],
    settledClaimIds: Set<OperationId>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const claim of claims) {
      if (signal.aborted) return;
      if (settledClaimIds.has(claim.operationId)) continue;
      const completed = await Promise.resolve()
        .then(async () => {
          if (signal.aborted) return false;
          await this.options.controlPlane.completeOperation({
            operationId: claim.operationId,
            status: 'failed',
            result: { summary: 'Reconciliation interrupted', retryable: true },
          }, signal);
          return true;
        })
        .then((result) => result, () => false);
      if (completed) settledClaimIds.add(claim.operationId);
    }
  }
}

function orderSnapshots(input: unknown, courtIds: FourCourtIds): SupervisorSnapshots {
  let snapshots: readonly CourtSnapshot[];
  try {
    snapshots = CourtSnapshotSchema.array().parse(input);
  } catch {
    throw new ProductionReconciliationError();
  }
  if (snapshots.length !== courtIds.length) throw new ProductionReconciliationError();
  const ordered = courtIds.map((courtId) => snapshots.find((snapshot) => snapshot.output.courtId === courtId));
  const [first, second, third, fourth] = ordered;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    throw new ProductionReconciliationError();
  }
  if (new Set(snapshots.map((snapshot) => snapshot.output.courtId)).size !== courtIds.length) {
    throw new ProductionReconciliationError();
  }
  return [first, second, third, fourth];
}

function operationCompletion(
  operation: Operation,
  snapshots: SupervisorSnapshots,
  reports: ReadonlyMap<CourtId, ReportObservedStateCommand>,
): CompleteOperationCommand {
  const snapshot = snapshots.find((current) =>
    current.desired.commandId === operation.commandId
    && current.output.id === operation.outputId
    && current.output.courtId === operation.courtId);
  if (snapshot === undefined) {
    return {
      operationId: operation.id,
      status: 'failed',
      result: { summary: 'Operation superseded', retryable: false },
    };
  }
  const report = reports.get(snapshot.output.courtId);
  if (report === undefined) throw new ProductionReconciliationError();
  const expectedHealth = completionHealth(snapshot);
  switch (report.health) {
    case 'healthy':
    case 'offline':
      return report.health === expectedHealth
        ? { operationId: operation.id, status: 'completed', result: { summary: 'Reconciliation applied', retryable: false } }
        : { operationId: operation.id, status: 'failed', result: { summary: 'Reconciliation failed', retryable: true } };
    case 'degraded':
      return { operationId: operation.id, status: 'failed', result: { summary: 'Reconciliation deferred', retryable: true } };
    case 'failed':
    case 'unknown':
      return { operationId: operation.id, status: 'failed', result: { summary: 'Reconciliation failed', retryable: true } };
    default:
      return assertNever(report.health);
  }
}

function completionHealth(snapshot: CourtSnapshot): 'healthy' | 'offline' {
  switch (snapshot.desired.desired.lifecycle) {
    case 'preflight':
    case 'running':
      return 'healthy';
    case 'off':
    case 'stopped':
      return 'offline';
    default:
      return assertNever(snapshot.desired.desired.lifecycle);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ControlPlaneAdapterError('ABORTED');
}

function assertNever(value: never): never {
  void value;
  throw new ProductionReconciliationError();
}
