import {
  CompleteOperationCommandSchema,
  OperationIdSchema,
  ProductionEventIdSchema,
  ReportObservedStateCommandSchema,
  SupabaseAssignedOutputSnapshotsSchema,
  SupabaseAssignedSecretRefsSchema,
  SupabaseClaimableOperationsResultSchema,
  SupabaseObservedOutputStateRowSchema,
  SupabaseOperationClaimRowSchema,
  type CompleteOperationCommand,
  type ObservedOutputState,
  type Operation,
  type OperationClaim,
  type OperationId,
  type ProductionEventId,
  type ReportObservedStateCommand,
  type SupabaseAssignedSecretRefs,
} from '@kpl/production-contracts';
import { CourtSnapshotSchema, type CourtSnapshot } from './config.js';
import {
  ControlPlaneAdapterError,
  type ControlPlaneAdapterErrorCode,
  type ControlPlanePort,
} from './control-plane.js';
import type { ControlPlaneRequest, ControlPlaneRequestExecutor } from './control-plane-request.js';

type Parser<Result> = {
  readonly safeParse: (input: unknown) =>
    | { readonly success: true; readonly data: Result }
    | { readonly success: false };
};

export class SupabaseControlPlane implements ControlPlanePort {
  private readonly execute: ControlPlaneRequestExecutor;

  public constructor(execute: ControlPlaneRequestExecutor) {
    this.execute = execute;
  }

  public async loadAssignedOutputSnapshots(
    signal: AbortSignal,
  ): Promise<readonly CourtSnapshot[]> {
    const rows = await this.request({
      kind: 'rpc',
      name: 'production_get_assigned_output_snapshots_v1',
      args: {},
    }, SupabaseAssignedOutputSnapshotsSchema, signal);
    return rows.map((row) => this.parse(CourtSnapshotSchema, row));
  }

  public async listClaimableOperations(
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly Operation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ControlPlaneAdapterError('INVALID_ARGUMENT');
    }
    return this.request({
      kind: 'rpc',
      name: 'production_list_claimable_operations_v1',
      args: { p_limit: limit },
    }, SupabaseClaimableOperationsResultSchema, signal);
  }

  public async claimOperation(
    operationId: OperationId,
    leaseSeconds: number,
    signal: AbortSignal,
  ): Promise<OperationClaim> {
    const parsedOperationId = this.parseArgument(OperationIdSchema, operationId);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
      throw new ControlPlaneAdapterError('INVALID_ARGUMENT');
    }
    return this.request({
      kind: 'rpc',
      name: 'production_claim_operation_v1',
      args: { p_operation_id: parsedOperationId, p_lease_seconds: leaseSeconds },
    }, SupabaseOperationClaimRowSchema, signal);
  }

  public async completeOperation(
    commandInput: CompleteOperationCommand,
    signal: AbortSignal,
  ): Promise<OperationClaim> {
    const command = this.parseArgument(CompleteOperationCommandSchema, commandInput);
    return this.request({
      kind: 'rpc',
      name: 'production_complete_operation_v1',
      args: {
        p_operation_id: command.operationId,
        p_status: command.status,
        p_result: command.result,
      },
    }, SupabaseOperationClaimRowSchema, signal);
  }

  public async reportObservedState(
    commandInput: ReportObservedStateCommand,
    signal: AbortSignal,
  ): Promise<ObservedOutputState> {
    const command = this.parseArgument(ReportObservedStateCommandSchema, commandInput);
    return this.request({
      kind: 'rpc',
      name: 'production_report_observed_state_v1',
      args: {
        p_output_id: command.outputId,
        p_sequence: command.sequence,
        p_health: command.health,
        p_state: command.state,
      },
    }, SupabaseObservedOutputStateRowSchema, signal);
  }

  public async loadAssignedSecretRefs(
    eventId: ProductionEventId,
    signal: AbortSignal,
  ): Promise<SupabaseAssignedSecretRefs> {
    const parsedEventId = this.parseArgument(ProductionEventIdSchema, eventId);
    return this.request({
      kind: 'rpc',
      name: 'production_get_assigned_secret_refs_v1',
      args: { p_event_id: parsedEventId },
    }, SupabaseAssignedSecretRefsSchema, signal);
  }

  private async request<Result>(
    request: ControlPlaneRequest,
    schema: Parser<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    if (signal.aborted) throw new ControlPlaneAdapterError('ABORTED');
    try {
      const response = await this.execute(request, signal);
      if (signal.aborted) throw new ControlPlaneAdapterError('ABORTED');
      if (response.error !== null) throw adapterError(response.error.code, response.error.message);
      return this.parse(schema, response.data);
    } catch (error) {
      if (error instanceof ControlPlaneAdapterError) throw error;
      if (signal.aborted) throw new ControlPlaneAdapterError('ABORTED');
      throw new ControlPlaneAdapterError('REQUEST_FAILED');
    }
  }

  private parse<Result>(schema: Parser<Result>, input: unknown): Result {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ControlPlaneAdapterError('MALFORMED_RESPONSE');
    return parsed.data;
  }

  private parseArgument<Result>(schema: Parser<Result>, input: unknown): Result {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ControlPlaneAdapterError('INVALID_ARGUMENT');
    return parsed.data;
  }
}

function adapterError(code: string, message: string): ControlPlaneAdapterError {
  let adapterCode: ControlPlaneAdapterErrorCode = 'REQUEST_FAILED';
  if (code === 'P0002') {
    adapterCode = 'NOT_FOUND';
  } else if (code === '42501' || message === 'FORBIDDEN' || message.startsWith('PRINCIPAL_KIND_REQUIRED')) {
    adapterCode = 'FORBIDDEN';
  } else if (message.includes('CONFLICT')) {
    adapterCode = 'CONFLICT';
  } else if (message.endsWith('NOT_FOUND')) {
    adapterCode = 'NOT_FOUND';
  } else if (message.startsWith('INVALID_')) {
    adapterCode = 'INVALID_ARGUMENT';
  }
  return new ControlPlaneAdapterError(adapterCode);
}
