import type { CourtId } from '@kpl/production-contracts';
import { isActiveLifecycle, selectAdmissions } from './admission.js';
import {
  AgentConfigSchema,
  SupervisorSnapshotsSchema,
  type CourtSnapshot,
  type SupervisorSnapshots,
} from './config.js';
import { CourtWorker } from './court-worker.js';
import type {
  CourtInspectionResult,
  CourtWorkerResult,
  SupervisorReconciliationResult,
  SupervisorShutdownResult,
} from './orchestration-models.js';
import type { CourtPipelinePort } from './ports.js';
import { SerializedTaskQueue } from './serialized-task-queue.js';

export type CourtPipelinePorts = readonly [
  CourtPipelinePort,
  CourtPipelinePort,
  CourtPipelinePort,
  CourtPipelinePort,
];

type CourtRoundEntry = {
  readonly worker: CourtWorker;
  readonly snapshot: CourtSnapshot;
  readonly inspection: CourtInspectionResult;
};

class IncompleteSupervisorRoundError extends Error {
  public constructor() {
    super('Supervisor round did not produce every court result');
    this.name = 'IncompleteSupervisorRoundError';
  }
}

class UnexpectedInspectionResultError extends Error {
  public constructor() {
    super('Unexpected inspection result');
    this.name = 'UnexpectedInspectionResultError';
  }
}

export class Supervisor {
  private readonly workers: readonly [CourtWorker, CourtWorker, CourtWorker, CourtWorker];
  private readonly queue = new SerializedTaskQueue();
  private readonly maxConcurrentPipelines: 3;
  private closed = false;
  private shutdownResult: Promise<SupervisorShutdownResult> | null = null;

  public constructor(configInput: unknown, ports: CourtPipelinePorts) {
    const config = AgentConfigSchema.parse(configInput);
    this.maxConcurrentPipelines = config.maxConcurrentPipelines;
    this.workers = [
      new CourtWorker(config.courts[0], ports[0]),
      new CourtWorker(config.courts[1], ports[1]),
      new CourtWorker(config.courts[2], ports[2]),
      new CourtWorker(config.courts[3], ports[3]),
    ];
  }

  public reconcile(input: unknown): Promise<SupervisorReconciliationResult> {
    return this.queue.run(() => this.reconcileRound(SupervisorSnapshotsSchema.parse(input)));
  }

  public shutdown(): Promise<SupervisorShutdownResult> {
    const existingShutdown = this.shutdownResult;
    if (existingShutdown !== null) return existingShutdown;

    this.closed = true;
    const courtShutdowns = this.workers.map((worker) => worker.shutdown());
    const shutdown = this.queue
      .run(async () => ({ courts: await Promise.all(courtShutdowns) }))
      .then(
        (result) => {
          if (result.courts.some((court) => court.kind === 'failed')) this.shutdownResult = null;
          return result;
        },
        (reason: unknown) => {
          this.shutdownResult = null;
          throw reason;
        },
      );
    this.shutdownResult = shutdown;
    return shutdown;
  }

  private async reconcileRound(
    snapshots: SupervisorSnapshots,
  ): Promise<SupervisorReconciliationResult> {
    if (this.closed) {
      return {
        courts: this.workers.map((worker) => ({
          kind: 'cancelled',
          courtId: worker.courtId,
          reason: 'shutdown',
        })),
      };
    }

    const inspections = await Promise.all([
      this.workers[0].inspect(snapshots[0]),
      this.workers[1].inspect(snapshots[1]),
      this.workers[2].inspect(snapshots[2]),
      this.workers[3].inspect(snapshots[3]),
    ]);
    const entries: readonly CourtRoundEntry[] = [
      { worker: this.workers[0], snapshot: snapshots[0], inspection: inspections[0] },
      { worker: this.workers[1], snapshot: snapshots[1], inspection: inspections[1] },
      { worker: this.workers[2], snapshot: snapshots[2], inspection: inspections[2] },
      { worker: this.workers[3], snapshot: snapshots[3], inspection: inspections[3] },
    ];
    const unknownReservations = entries.filter((entry) => entry.inspection.kind !== 'ready').length;
    const incumbentCapacity = Math.max(
      0,
      this.maxConcurrentPipelines - unknownReservations,
    );
    const admitted = selectAdmissions(
      entries.map((entry) => ({
        courtId: entry.worker.courtId,
        lifecycle: entry.snapshot.desired.desired.lifecycle,
        runtime: entry.inspection.kind === 'ready' ? entry.inspection.runtime : null,
        inspectable: entry.inspection.kind === 'ready',
      })),
      incumbentCapacity,
    );
    const results = new Map<CourtId, CourtWorkerResult>();

    await Promise.all(
      entries.map(async (entry) => {
        if (
          entry.inspection.kind === 'ready' &&
          entry.inspection.runtime === null &&
          isActiveLifecycle(entry.snapshot.desired.desired.lifecycle)
        ) {
          return;
        }
        const result = entry.inspection.kind === 'ready'
          ? await entry.worker.reconcile(
              entry.snapshot,
              admitted.has(entry.worker.courtId) ? 'admitted' : 'capacity-deferred',
            )
          : inspectionFailure(entry.inspection);
        results.set(entry.worker.courtId, result);
      }),
    );

    let occupiedCapacity = unknownReservations + entries.filter(
      (entry) => entry.inspection.kind === 'ready' && entry.worker.isActive,
    ).length;
    for (const entry of entries) {
      if (results.has(entry.worker.courtId)) continue;
      const decision = occupiedCapacity < this.maxConcurrentPipelines
        ? 'admitted'
        : 'capacity-deferred';
      const result = await entry.worker.reconcile(entry.snapshot, decision);
      results.set(entry.worker.courtId, result);
      if (entry.worker.isActive) occupiedCapacity += 1;
    }

    return {
      courts: entries.map((entry) => {
        const result = results.get(entry.worker.courtId);
        if (result === undefined) throw new IncompleteSupervisorRoundError();
        return result;
      }),
    };
  }
}

function inspectionFailure(inspection: Exclude<CourtInspectionResult, { readonly kind: 'ready' }>): CourtWorkerResult {
  switch (inspection.kind) {
    case 'failed':
    case 'cancelled':
      return inspection;
    default:
      return assertNever(inspection);
  }
}

function assertNever(value: never): never {
  void value;
  throw new UnexpectedInspectionResultError();
}
