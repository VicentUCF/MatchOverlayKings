import { z } from 'zod';
import {
  SupabaseAssignmentRowSchema,
  SupabaseEventDayRowSchema,
  SupabaseProductionEventRowSchema,
  SupabaseSafeDeviceRowSchema,
  SupabaseSafeOutputRowSchema,
  PilotCourtSlugSchema,
} from '@kpl/production-contracts';
import { supabase } from './supabase.js';
import type {
  ProductionSetupInventoryAdapter,
  ProductionSetupInventoryLoadResult,
} from './production-setup-types.js';

const TABLES = {
  principals: ['production_principals', 'id,club_id,auth_user_id,kind,display_name,active,version,created_at,updated_at'],
  eventDays: ['production_event_days', 'id,club_id,name,event_date,time_zone,status,version,created_at,updated_at'],
  devices: ['production_devices', 'id,club_id,principal_id,name,kind,enabled,last_heartbeat_at,heartbeat_status,version,created_at,updated_at'],
  courts: ['courts', 'id,club_id,slug,name,display_order,production_enabled'],
  events: ['production_events', 'id,event_day_id,club_id,court_id,title,scheduled_start_at,scheduled_end_at,status,version,created_at,updated_at'],
  assignments: ['production_assignments', 'id,club_id,event_id,principal_id,role,active,version,created_at,updated_at'],
  outputs: ['production_outputs', 'id,club_id,event_id,court_id,name,kind,transport,enabled,version,created_at,updated_at'],
} as const;

type InventoryTable = (typeof TABLES)[keyof typeof TABLES][0];

export type ProductionSetupInventoryBackend = {
  readonly select: (table: InventoryTable, columns: string, clubId: string) => Promise<unknown>;
};

const ErrorSchema = z.object({ code: z.string().optional(), message: z.string() });
const EnvelopeSchema = z.object({ data: z.unknown(), error: ErrorSchema.nullable() });
const PrincipalRowsSchema = z.array(z.strictObject({
  id: z.uuid(), club_id: z.uuid(), auth_user_id: z.uuid(), kind: z.enum(['human', 'agent', 'device']),
  display_name: z.string().trim().min(1), active: z.boolean(), version: z.number().int().positive(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
})).readonly().transform((rows) => rows.flatMap((row) => row.kind === 'human' ? [] : [{
  id: row.id, clubId: row.club_id, authUserId: row.auth_user_id, kind: row.kind,
  displayName: row.display_name, active: row.active, version: row.version,
}]));
const CourtRowsSchema = z.array(z.strictObject({
  id: z.uuid(), club_id: z.uuid(), slug: PilotCourtSlugSchema, name: z.string().trim().min(1),
  display_order: z.number().int(), production_enabled: z.boolean(),
}).transform((row) => ({
  id: row.id, clubId: row.club_id, slug: row.slug, name: row.name,
  displayOrder: row.display_order, productionEnabled: row.production_enabled,
}))).min(1).readonly();

const DEFAULT_BACKEND: ProductionSetupInventoryBackend = Object.freeze({
  select: async (table, columns, clubId) => supabase.from(table).select(columns).eq('club_id', clubId),
});

type ParsedRows<Value> =
  | { readonly kind: 'success'; readonly value: Value }
  | { readonly kind: 'forbidden' | 'malformed' | 'transport' };

export function createProductionSetupInventoryAdapter(
  backend: ProductionSetupInventoryBackend = DEFAULT_BACKEND,
): ProductionSetupInventoryAdapter {
  return Object.freeze({
    load: async (clubId): Promise<ProductionSetupInventoryLoadResult> => {
      try {
        const [principals, eventDays, devices, courts, events, assignments, outputs] = await Promise.all([
          loadRows(backend, TABLES.principals, clubId, PrincipalRowsSchema),
          loadRows(backend, TABLES.eventDays, clubId, z.array(SupabaseEventDayRowSchema).readonly()),
          loadRows(backend, TABLES.devices, clubId, z.array(SupabaseSafeDeviceRowSchema).readonly()),
          loadRows(backend, TABLES.courts, clubId, CourtRowsSchema),
          loadRows(backend, TABLES.events, clubId, z.array(SupabaseProductionEventRowSchema).readonly()),
          loadRows(backend, TABLES.assignments, clubId, z.array(SupabaseAssignmentRowSchema).readonly()),
          loadRows(backend, TABLES.outputs, clubId, z.array(SupabaseSafeOutputRowSchema).readonly()),
        ]);
        const failure = [principals, eventDays, devices, courts, events, assignments, outputs]
          .find((result) => result.kind !== 'success');
        if (failure !== undefined) return { kind: failure.kind };
        if (principals.kind !== 'success' || eventDays.kind !== 'success' || devices.kind !== 'success'
          || courts.kind !== 'success' || events.kind !== 'success' || assignments.kind !== 'success'
          || outputs.kind !== 'success') return { kind: 'malformed' };
        return { kind: 'success', inventory: {
          principals: principals.value, eventDays: eventDays.value, devices: devices.value,
          courts: [...courts.value].sort((left, right) =>
            left.displayOrder - right.displayOrder || left.slug.localeCompare(right.slug)),
          events: events.value, assignments: assignments.value, outputs: outputs.value,
        } };
      } catch (error) {
        if (error instanceof Error) return { kind: 'transport' };
        return { kind: 'transport' };
      }
    },
  });
}

async function loadRows<Value>(
  backend: ProductionSetupInventoryBackend,
  table: readonly [InventoryTable, string],
  clubId: string,
  schema: z.ZodType<Value>,
): Promise<ParsedRows<Value>> {
  const envelope = EnvelopeSchema.safeParse(await backend.select(table[0], table[1], clubId));
  if (!envelope.success) return { kind: 'malformed' };
  if (envelope.data.error !== null) {
    return envelope.data.error.code === '42501' || envelope.data.error.message === 'FORBIDDEN'
      ? { kind: 'forbidden' }
      : { kind: 'transport' };
  }
  const rows = schema.safeParse(envelope.data.data);
  return rows.success ? { kind: 'success', value: rows.data } : { kind: 'malformed' };
}
