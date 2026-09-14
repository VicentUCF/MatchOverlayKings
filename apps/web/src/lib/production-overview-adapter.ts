import { z } from 'zod';
import {
  CommandIdSchema,
  DesiredLifecycleSchema,
  DesiredOutputSpecSchema,
  SupabaseDesiredOutputStateRowSchema,
} from '@kpl/production-contracts';
import { createCommandId } from '../command-id.js';
import { mapProductionOverviewData, resolveProductionIdentity } from './production-overview-mapper.js';
import type {
  ProductionCourtAssignment,
  ProductionLoadResult,
  ProductionMutationResult,
  ProductionOverviewAdapter,
} from './production-overview-types.js';
import { createSupabaseProductionBackend } from './production-supabase-backend.js';
import { supabase } from './supabase.js';

export const PRODUCTION_TABLES = [
  'production_principals',
  'production_principal_roles',
  'courts',
  'production_assignments',
  'production_events',
  'production_outputs',
  'production_desired_states',
  'production_observed_states',
  'production_operations',
  'production_operation_claims',
  'score_states',
] as const;

export type ProductionTable = (typeof PRODUCTION_TABLES)[number];
const REALTIME_TABLES = [
  'production_desired_states',
  'production_observed_states',
  'production_operations',
  'production_operation_claims',
] as const;
type RealtimeProductionTable = (typeof REALTIME_TABLES)[number];

export type ProductionBackend = {
  readonly currentUser: () => Promise<unknown>;
  readonly select: (
    table: ProductionTable,
    filter: { readonly column: string; readonly value: string },
  ) => Promise<unknown>;
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly subscribe: (
    table: RealtimeProductionTable,
    clubId: string,
    onChange: () => void,
  ) => { readonly remove: () => Promise<unknown> };
};

const ErrorSchema = z.object({ code: z.string().optional(), message: z.string() });
const ResponseSchema = z.object({ data: z.unknown(), error: ErrorSchema.nullable() });
const UserResponseDataSchema = z.strictObject({ user: z.strictObject({ id: z.uuid() }).nullable() });
const DATA_TABLES = PRODUCTION_TABLES.filter((table) => table !== 'production_principals');

export function createProductionOverviewAdapter(
  backend: ProductionBackend = createSupabaseProductionBackend(supabase),
  commandId: () => string = createCommandId,
): ProductionOverviewAdapter {
  async function load(): Promise<ProductionLoadResult> {
    try {
      const userResponse = parseResponse(await backend.currentUser());
      if (userResponse.kind !== 'success') return userResponse;
      const userData = UserResponseDataSchema.safeParse(userResponse.data);
      if (!userData.success) return { kind: 'malformed' };
      if (userData.data.user === null) return { kind: 'forbidden' };
      const principalResponse = parseResponse(await backend.select('production_principals', {
        column: 'auth_user_id',
        value: userData.data.user.id,
      }));
      if (principalResponse.kind !== 'success') return principalResponse;
      const identity = resolveProductionIdentity(userData.data.user.id, principalResponse.data);
      if (identity.kind !== 'success') return identity;
      const responses = await Promise.all(DATA_TABLES.map(async (table) => ({
        table,
        response: parseResponse(await backend.select(table, { column: 'club_id', value: identity.clubId })),
      })));
      const failed = responses.find(({ response }) => response.kind !== 'success');
      if (failed !== undefined && failed.response.kind !== 'success') return failed.response;
      const dataset: Record<string, unknown> = { production_principals: principalResponse.data };
      for (const item of responses) {
        if (item.response.kind === 'success') dataset[item.table] = item.response.data;
      }
      const mapped = mapProductionOverviewData(userData.data.user.id, dataset);
      if (mapped.kind !== 'success') return mapped;
      if (mapped.capability === 'viewer') {
        return { kind: 'success', access: Object.freeze({ kind: 'viewer', snapshot: mapped.snapshot }) };
      }
      return {
        kind: 'success',
        access: Object.freeze({
          kind: 'operator',
          snapshot: mapped.snapshot,
          reconcile: (assignment, lifecycle) => reconcile(backend, commandId, assignment, lifecycle),
        }),
      };
    } catch (error) {
      if (error instanceof Error) return { kind: 'transport' };
      return { kind: 'transport' };
    }
  }

  return Object.freeze({
    load,
    subscribe: (access, onChange) => {
      const clubId = access.snapshot.clubId;
      const channels = REALTIME_TABLES.map((table) => backend.subscribe(table, clubId, onChange));
      return () => {
        for (const channel of channels) void channel.remove();
      };
    },
  });
}

async function reconcile(
  backend: ProductionBackend,
  commandIdFactory: () => string,
  assignment: ProductionCourtAssignment,
  lifecycleInput: unknown,
): Promise<ProductionMutationResult> {
  const lifecycle = DesiredLifecycleSchema.safeParse(lifecycleInput);
  const nextCommandId = CommandIdSchema.safeParse(commandIdFactory());
  const state = DesiredOutputSpecSchema.safeParse({
    lifecycle: lifecycle.success ? lifecycle.data : lifecycleInput,
    profile: assignment.desired.desired.profile,
  });
  if (!lifecycle.success || !nextCommandId.success || !state.success) return { kind: 'malformed' };
  try {
    const response = ResponseSchema.safeParse(await backend.rpc('production_set_desired_state_v1', {
      p_output_id: assignment.output.id,
      p_state: state.data,
      p_expected_version: assignment.desired.version,
      p_command_id: nextCommandId.data,
      p_operation_kind: 'reconcile',
      p_operation_payload: {},
    }));
    if (!response.success) return { kind: 'malformed' };
    if (response.data.error !== null) return mutationError(response.data.error);
    const desired = SupabaseDesiredOutputStateRowSchema.safeParse(response.data.data);
    if (!desired.success) return { kind: 'malformed' };
    return { kind: 'accepted', acknowledgement: 'reconciliation_requested', desired: desired.data };
  } catch (error) {
    if (error instanceof Error) return { kind: 'transport' };
    return { kind: 'transport' };
  }
}

type ParsedResponse =
  | { readonly kind: 'success'; readonly data: unknown }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'transport' };

function parseResponse(input: unknown): ParsedResponse {
  const response = ResponseSchema.safeParse(input);
  if (!response.success) return { kind: 'malformed' };
  if (response.data.error === null) return { kind: 'success', data: response.data.data };
  return isForbidden(response.data.error) ? { kind: 'forbidden' } : { kind: 'transport' };
}

function mutationError(error: z.infer<typeof ErrorSchema>): ProductionMutationResult {
  if (isForbidden(error)) return { kind: 'forbidden' };
  const match = /^VERSION_CONFLICT:(\d+)$/.exec(error.message);
  const version = z.coerce.number().int().nonnegative().safeParse(match?.[1]);
  if (version.success) return { kind: 'conflict', currentVersion: version.data };
  return { kind: 'transport' };
}

function isForbidden(error: z.infer<typeof ErrorSchema>): boolean {
  return error.code === '42501'
    || error.message === 'FORBIDDEN'
    || error.message.startsWith('PRINCIPAL_KIND_REQUIRED');
}
