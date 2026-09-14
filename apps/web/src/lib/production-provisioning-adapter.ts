import { z } from 'zod';
import {
  CommandIdSchema,
  SupabaseAssignmentRowSchema,
  SupabaseEventDayRowSchema,
  SupabasePrincipalRowSchema,
  SupabaseProductionEventRowSchema,
  SupabaseSafeDeviceRowSchema,
  SupabaseSafeOutputRowSchema,
  type CommandId,
} from '@kpl/production-contracts';
import { createCommandId } from '../command-id.js';
import {
  ScheduleProductionEventInputSchema,
  SetProductionEventStatusInputSchema,
  UpsertAssignmentInputSchema,
  UpsertDeviceInputSchema,
  UpsertEventDayInputSchema,
  UpsertMachinePrincipalInputSchema,
  UpsertSrtProgramOutputInputSchema,
  type ProductionProvisioningAdapter,
  type ProductionProvisioningResult,
} from './production-provisioning-contracts.js';
import { supabase } from './supabase.js';

export type ProductionProvisioningBackend = {
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

type ProvisioningOperation<Input, Value> = {
  readonly inputSchema: z.ZodType<Input>;
  readonly responseSchema: z.ZodType<Value>;
  readonly rpcName: string;
  readonly args: (input: Input, commandId: CommandId) => Record<string, unknown>;
};

const RpcErrorSchema = z.object({ code: z.string().optional(), message: z.string() });
const RpcResponseSchema = z.object({ data: z.unknown(), error: RpcErrorSchema.nullable() });
const ConflictVersionSchema = z.coerce.number().int().nonnegative();
const DEFAULT_BACKEND: ProductionProvisioningBackend = Object.freeze({
  rpc: async (name, args) => supabase.rpc(name, args),
});

export function createProductionProvisioningAdapter(
  backend: ProductionProvisioningBackend = DEFAULT_BACKEND,
  commandIdFactory: () => string = createCommandId,
): ProductionProvisioningAdapter {
  async function execute<Input, Value>(
    operation: ProvisioningOperation<Input, Value>,
    rawInput: unknown,
  ): Promise<ProductionProvisioningResult<Value>> {
    const input = operation.inputSchema.safeParse(rawInput);
    if (!input.success) return { kind: 'validation' };
    const commandId = CommandIdSchema.safeParse(commandIdFactory());
    if (!commandId.success) return { kind: 'malformed' };

    try {
      const envelope = RpcResponseSchema.safeParse(
        await backend.rpc(operation.rpcName, operation.args(input.data, commandId.data)),
      );
      if (!envelope.success) return { kind: 'malformed' };
      if (envelope.data.error !== null) return mapRpcError(envelope.data.error);
      const value = operation.responseSchema.safeParse(envelope.data.data);
      return value.success ? { kind: 'accepted', value: value.data } : { kind: 'malformed' };
    } catch (error) {
      if (error instanceof Error) return { kind: 'transport' };
      return { kind: 'transport' };
    }
  }

  return Object.freeze({
    upsertEventDay: (input) => execute({
      inputSchema: UpsertEventDayInputSchema,
      responseSchema: SupabaseEventDayRowSchema,
      rpcName: 'production_upsert_event_day_v1',
      args: (value, commandId) => ({
        p_club_id: value.clubId, p_event_day_id: value.eventDayId, p_name: value.name,
        p_event_date: value.eventDate, p_time_zone: value.timeZone, p_status: value.status,
        p_expected_version: value.expectedVersion, p_command_id: commandId,
      }),
    }, input),
    upsertMachinePrincipal: (input) => execute({
      inputSchema: UpsertMachinePrincipalInputSchema,
      responseSchema: SupabasePrincipalRowSchema,
      rpcName: 'production_upsert_machine_principal_v1',
      args: (value, commandId) => ({
        p_principal_id: value.principalId, p_club_id: value.clubId, p_auth_user_id: value.authUserId,
        p_kind: value.kind, p_display_name: value.displayName, p_active: value.active,
        p_expected_version: value.expectedVersion, p_command_id: commandId,
      }),
    }, input),
    upsertDevice: (input) => execute({
      inputSchema: UpsertDeviceInputSchema,
      responseSchema: SupabaseSafeDeviceRowSchema,
      rpcName: 'production_upsert_device_v1',
      args: (value, commandId) => ({
        p_device_id: value.deviceId, p_principal_id: value.principalId, p_name: value.name,
        p_kind: value.kind, p_secret_ref: value.secretRef, p_enabled: value.enabled,
        p_expected_version: value.expectedVersion, p_command_id: commandId,
      }),
    }, input),
    scheduleEvent: (input) => execute({
      inputSchema: ScheduleProductionEventInputSchema,
      responseSchema: SupabaseProductionEventRowSchema,
      rpcName: 'production_schedule_event_v1',
      args: (value, commandId) => ({
        p_event_id: value.eventId, p_event_day_id: value.eventDayId, p_court_slug: value.courtSlug,
        p_title: value.title, p_scheduled_start_at: value.scheduledStartAt,
        p_scheduled_end_at: value.scheduledEndAt, p_expected_version: value.expectedVersion,
        p_command_id: commandId,
      }),
    }, input),
    upsertAssignment: (input) => execute({
      inputSchema: UpsertAssignmentInputSchema,
      responseSchema: SupabaseAssignmentRowSchema,
      rpcName: 'production_upsert_assignment_v1',
      args: (value, commandId) => ({
        p_assignment_id: value.assignmentId, p_event_id: value.eventId, p_principal_id: value.principalId,
        p_role: value.role, p_active: value.active, p_expected_version: value.expectedVersion,
        p_command_id: commandId,
      }),
    }, input),
    upsertOutput: (input) => execute({
      inputSchema: UpsertSrtProgramOutputInputSchema,
      responseSchema: SupabaseSafeOutputRowSchema,
      rpcName: 'production_upsert_output_v1',
      args: (value, commandId) => ({
        p_output_id: value.outputId, p_event_id: value.eventId, p_name: value.name,
        p_kind: value.kind, p_transport: value.transport, p_secret_ref: value.secretRef,
        p_enabled: value.enabled, p_expected_version: value.expectedVersion, p_command_id: commandId,
      }),
    }, input),
    setEventStatus: (input) => execute({
      inputSchema: SetProductionEventStatusInputSchema,
      responseSchema: SupabaseProductionEventRowSchema,
      rpcName: 'production_set_event_status_v1',
      args: (value, commandId) => ({
        p_event_id: value.eventId, p_status: value.status,
        p_expected_version: value.expectedVersion, p_command_id: commandId,
      }),
    }, input),
  });
}

function mapRpcError(error: z.infer<typeof RpcErrorSchema>): ProductionProvisioningResult<never> {
  if (error.code === '42501' || error.message === 'FORBIDDEN'
    || error.message.startsWith('PRINCIPAL_KIND_REQUIRED:')) return { kind: 'forbidden' };
  const match = /^VERSION_CONFLICT:(\d+)$/.exec(error.message);
  const currentVersion = ConflictVersionSchema.safeParse(match?.[1]);
  return currentVersion.success
    ? { kind: 'conflict', currentVersion: currentVersion.data }
    : { kind: 'transport' };
}
