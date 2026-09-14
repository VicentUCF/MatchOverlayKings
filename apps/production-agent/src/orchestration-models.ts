import type { CourtId, OutputId } from '@kpl/production-contracts';
import type { PipelineRuntime, ReconciliationResult } from './models.js';

export type AdmissionDecision = 'admitted' | 'capacity-deferred';

export type CourtInspectionResult =
  | {
      readonly kind: 'ready';
      readonly courtId: CourtId;
      readonly runtime: PipelineRuntime | null;
    }
  | {
      readonly kind: 'failed';
      readonly courtId: CourtId;
      readonly error: Error;
    }
  | {
      readonly kind: 'cancelled';
      readonly courtId: CourtId;
      readonly reason: 'shutdown';
    };

export type CourtWorkerResult =
  | {
      readonly kind: 'reconciled';
      readonly courtId: CourtId;
      readonly reconciliation: ReconciliationResult;
      readonly runtime: PipelineRuntime | null;
    }
  | {
      readonly kind: 'degraded';
      readonly health: 'degraded';
      readonly reason: 'capacity';
      readonly courtId: CourtId;
      readonly outputId: OutputId;
    }
  | {
      readonly kind: 'failed';
      readonly courtId: CourtId;
      readonly error: Error;
    }
  | {
      readonly kind: 'cancelled';
      readonly courtId: CourtId;
      readonly reason: 'shutdown';
    };

export type CourtShutdownResult =
  | { readonly kind: 'stopped'; readonly courtId: CourtId }
  | { readonly kind: 'idle'; readonly courtId: CourtId }
  | { readonly kind: 'failed'; readonly courtId: CourtId; readonly error: Error };

export type SupervisorReconciliationResult = {
  readonly courts: readonly CourtWorkerResult[];
};

export type SupervisorShutdownResult = {
  readonly courts: readonly CourtShutdownResult[];
};
