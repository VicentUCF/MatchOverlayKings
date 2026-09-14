import type { CourtId } from '@kpl/production-contracts';
import { isActiveLifecycle } from './admission.js';
import type { CourtSnapshot, CourtWorkerConfig } from './config.js';
import type { PipelineRuntime, PipelineTarget, ReconciliationAction } from './models.js';
import type {
  AdmissionDecision,
  CourtInspectionResult,
  CourtShutdownResult,
  CourtWorkerResult,
} from './orchestration-models.js';
import type { CourtPipelinePort } from './ports.js';
import { reconcileOutput } from './reconcile.js';
import { SerializedTaskQueue } from './serialized-task-queue.js';
import {
  CourtConfigurationMismatchError,
  RuntimeOutputMismatchError,
  UnexpectedWorkerActionError,
} from './worker-errors.js';

export class CourtWorker {
  public readonly courtId: CourtId;
  private readonly port: CourtPipelinePort;
  private readonly queue = new SerializedTaskQueue();
  private readonly lifetimeController = new AbortController();
  private pipelineController: AbortController | null = null;
  private runtime: PipelineRuntime | null = null;
  private inspected = false;
  private closed = false;

  public constructor(config: CourtWorkerConfig, port: CourtPipelinePort) {
    this.courtId = config.courtId;
    this.port = port;
  }

  public get isActive(): boolean {
    return this.runtime !== null;
  }

  public inspect(snapshot: CourtSnapshot): Promise<CourtInspectionResult> {
    return this.queue.run(() => this.inspectRuntime(snapshot));
  }

  public reconcile(
    snapshot: CourtSnapshot,
    admission: AdmissionDecision,
  ): Promise<CourtWorkerResult> {
    return this.queue.run(async () => {
      if (this.closed) return this.cancelledResult();
      if (!this.inspected) {
        const inspection = await this.inspectRuntime(snapshot);
        switch (inspection.kind) {
          case 'ready':
            break;
          case 'failed':
          case 'cancelled':
            return inspection;
          default:
            return assertNever(inspection);
        }
      }

      try {
        if (
          isActiveLifecycle(snapshot.desired.desired.lifecycle) &&
          admission === 'capacity-deferred'
        ) {
          const deferred = await this.deferForCapacity(snapshot);
          return this.closed ? this.cancelledResult() : deferred;
        }
        const reconciliation = reconcileOutput({ ...snapshot, runtime: this.runtime });
        const completion = await this.executeAction(reconciliation.action);
        if (this.closed || completion === 'cancelled') return this.cancelledResult();
        return { kind: 'reconciled', courtId: this.courtId, reconciliation, runtime: this.runtime };
      } catch (error) {
        if (this.closed) return this.cancelledResult();
        if (error instanceof Error) return { kind: 'failed', courtId: this.courtId, error };
        throw error;
      }
    });
  }

  public shutdown(): Promise<CourtShutdownResult> {
    this.closed = true;
    this.lifetimeController.abort();
    this.pipelineController?.abort();
    return this.queue.run(async () => {
      if (this.runtime === null) return { kind: 'idle', courtId: this.courtId };
      const cleanupController = new AbortController();
      try {
        await this.port.stop(this.runtime, cleanupController.signal);
        this.runtime = null;
        this.pipelineController = null;
        cleanupController.abort();
        return { kind: 'stopped', courtId: this.courtId };
      } catch (error) {
        cleanupController.abort();
        if (error instanceof Error) return { kind: 'failed', courtId: this.courtId, error };
        throw error;
      }
    });
  }

  private async inspectRuntime(snapshot: CourtSnapshot): Promise<CourtInspectionResult> {
    this.inspected = false;
    if (this.closed) return this.cancelledResult();
    if (snapshot.output.courtId !== this.courtId) {
      return { kind: 'failed', courtId: this.courtId, error: new CourtConfigurationMismatchError() };
    }
    try {
      const runtime = await this.port.getRuntime(
        snapshot.output.id,
        this.lifetimeController.signal,
      );
      if (runtime !== null && runtime.outputId !== snapshot.output.id) {
        return { kind: 'failed', courtId: this.courtId, error: new RuntimeOutputMismatchError() };
      }
      this.runtime = runtime;
      if (this.closed) return this.cancelledResult();
      this.inspected = true;
      return { kind: 'ready', courtId: this.courtId, runtime: this.runtime };
    } catch (error) {
      if (this.closed) return this.cancelledResult();
      if (error instanceof Error) return { kind: 'failed', courtId: this.courtId, error };
      throw error;
    }
  }

  private async deferForCapacity(snapshot: CourtSnapshot): Promise<CourtWorkerResult> {
    if (this.runtime !== null) {
      this.pipelineController?.abort();
      await this.port.stop(this.runtime, this.lifetimeController.signal);
      this.runtime = null;
      this.pipelineController = null;
    }
    return {
      kind: 'degraded',
      health: 'degraded',
      reason: 'capacity',
      courtId: this.courtId,
      outputId: snapshot.output.id,
    };
  }

  private async executeAction(action: ReconciliationAction): Promise<'complete' | 'cancelled'> {
    switch (action.kind) {
      case 'start':
        return this.startPipeline(action.target);
      case 'stop':
        this.pipelineController?.abort();
        await this.stopPipeline();
        return 'complete';
      case 'restart':
        this.pipelineController?.abort();
        await this.stopPipeline();
        if (this.closed) return 'cancelled';
        return this.startPipeline(action.target);
      case 'noop':
        return 'complete';
      default:
        return assertNever(action);
    }
  }

  private async stopPipeline(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) throw new UnexpectedWorkerActionError();
    await this.port.stop(runtime, this.lifetimeController.signal);
    this.runtime = null;
    this.pipelineController = null;
  }

  private async startPipeline(target: PipelineTarget): Promise<'complete' | 'cancelled'> {
    if (this.closed) return 'cancelled';
    const controller = new AbortController();
    this.pipelineController = controller;
    try {
      const runtime = await this.port.start(target, controller.signal);
      this.runtime = runtime;
      if (this.closed) return 'cancelled';
      return 'complete';
    } catch (error) {
      controller.abort();
      this.pipelineController = null;
      if (this.closed) return 'cancelled';
      throw error;
    }
  }

  private cancelledResult(): CourtWorkerResult & CourtInspectionResult {
    return { kind: 'cancelled', courtId: this.courtId, reason: 'shutdown' };
  }
}

function assertNever(value: never): never {
  void value;
  throw new UnexpectedWorkerActionError();
}
