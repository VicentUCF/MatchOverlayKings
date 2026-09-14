import type {
  CompleteOperationCommand,
  ObservedOutputState,
  Operation,
  OperationClaim,
  OperationId,
  ProductionEventId,
  ReportObservedStateCommand,
  SupabaseAssignedSecretRefs,
} from '@kpl/production-contracts';
import type { CourtSnapshot } from './config.js';

export interface ControlPlanePort {
  readonly loadAssignedOutputSnapshots: (
    signal: AbortSignal,
  ) => Promise<readonly CourtSnapshot[]>;
  readonly listClaimableOperations: (
    limit: number,
    signal: AbortSignal,
  ) => Promise<readonly Operation[]>;
  readonly claimOperation: (
    operationId: OperationId,
    leaseSeconds: number,
    signal: AbortSignal,
  ) => Promise<OperationClaim>;
  readonly completeOperation: (
    command: CompleteOperationCommand,
    signal: AbortSignal,
  ) => Promise<OperationClaim>;
  readonly reportObservedState: (
    command: ReportObservedStateCommand,
    signal: AbortSignal,
  ) => Promise<ObservedOutputState>;
  readonly loadAssignedSecretRefs: (
    eventId: ProductionEventId,
    signal: AbortSignal,
  ) => Promise<SupabaseAssignedSecretRefs>;
}

export type ControlPlaneAdapterErrorCode =
  | 'ABORTED'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'MALFORMED_RESPONSE'
  | 'NOT_FOUND'
  | 'REQUEST_FAILED';

const errorMessages = {
  ABORTED: 'Control-plane request aborted',
  CONFLICT: 'Control-plane operation conflict',
  FORBIDDEN: 'Control-plane request forbidden',
  INVALID_ARGUMENT: 'Invalid control-plane argument',
  MALFORMED_RESPONSE: 'Malformed control-plane response',
  NOT_FOUND: 'Control-plane resource not found',
  REQUEST_FAILED: 'Control-plane request failed',
} as const satisfies Record<ControlPlaneAdapterErrorCode, string>;

export class ControlPlaneAdapterError extends Error {
  public readonly code: ControlPlaneAdapterErrorCode;

  public constructor(code: ControlPlaneAdapterErrorCode) {
    super(errorMessages[code]);
    this.name = 'ControlPlaneAdapterError';
    this.code = code;
  }
}
