import { z } from 'zod';
import { AssetSpecIdSchema, AssignmentIdSchema, CommandIdSchema, ClubIdSchema, CourtIdSchema, DateSchema, DeviceIdSchema, EventDayIdSchema, JsonValueSchema, LocalSecretRefSchema, OperationIdSchema, OutputIdSchema, PrincipalIdSchema, ProductionEventIdSchema, TimestampSchema, VersionSchema } from './common.js';
import { AssetKindSchema, AssetSpecSchema } from './assets.js';
import { AssignmentRoleSchema, DeviceKindSchema, DeviceSchema, PrincipalKindSchema, PrincipalSchema, ProductionAssignmentSchema } from './identities.js';
import { OperationClaimSchema, OperationClaimStatusSchema, OperationKindSchema, OperationPayloadSchema, OperationResultSchema, OperationSchema } from './operations.js';
import { DesiredOutputSpecSchema, DesiredOutputStateSchema, ObservedHealthSchema, ObservedOutputStateSchema, OutputKindSchema, OutputSchema, OutputTransportSchema } from './outputs.js';
import { EventDayStatusSchema, ProductionEventDaySchema, ProductionEventSchema, ProductionEventStatusSchema } from './scheduling.js';

const auditFields = { created_at: TimestampSchema, updated_at: TimestampSchema } as const;
const SupabaseSequenceSchema = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

export const SupabaseEventDayRowSchema = z.strictObject({ id: EventDayIdSchema, club_id: ClubIdSchema, name: z.string(), event_date: DateSchema, time_zone: z.string(), status: EventDayStatusSchema, version: VersionSchema, ...auditFields }).transform((row) => ProductionEventDaySchema.parse({ id: row.id, clubId: row.club_id, name: row.name, eventDate: row.event_date, timeZone: row.time_zone, status: row.status, version: row.version }));

export const SupabasePrincipalRowSchema = z.strictObject({ id: PrincipalIdSchema, club_id: ClubIdSchema, auth_user_id: z.uuid(), kind: PrincipalKindSchema, display_name: z.string(), active: z.boolean(), version: VersionSchema, ...auditFields }).transform((row) => PrincipalSchema.parse({ id: row.id, clubId: row.club_id, kind: row.kind, displayName: row.display_name, active: row.active, version: row.version }));

export const SupabaseAssignmentRowSchema = z.strictObject({ id: AssignmentIdSchema, club_id: ClubIdSchema, event_id: ProductionEventIdSchema, principal_id: PrincipalIdSchema, role: AssignmentRoleSchema, active: z.boolean(), version: VersionSchema, ...auditFields }).transform((row) => ProductionAssignmentSchema.parse({ id: row.id, eventId: row.event_id, principalId: row.principal_id, role: row.role, active: row.active, version: row.version }));

export const SupabaseSafeDeviceRowSchema = z.strictObject({ id: DeviceIdSchema, club_id: ClubIdSchema, principal_id: PrincipalIdSchema, name: z.string(), kind: DeviceKindSchema, enabled: z.boolean(), last_heartbeat_at: TimestampSchema.nullable(), heartbeat_status: JsonValueSchema, version: VersionSchema, ...auditFields }).transform((row) => DeviceSchema.parse({ id: row.id, clubId: row.club_id, principalId: row.principal_id, name: row.name, kind: row.kind, enabled: row.enabled, lastHeartbeatAt: row.last_heartbeat_at, version: row.version }));

export const SupabaseSafeOutputRowSchema = z.strictObject({ id: OutputIdSchema, club_id: ClubIdSchema, event_id: ProductionEventIdSchema, court_id: CourtIdSchema, name: z.string(), kind: OutputKindSchema, transport: OutputTransportSchema, enabled: z.boolean(), version: VersionSchema, ...auditFields }).transform((row) => OutputSchema.parse({ id: row.id, clubId: row.club_id, eventId: row.event_id, courtId: row.court_id, name: row.name, kind: row.kind, transport: row.transport, enabled: row.enabled, version: row.version }));

export const SupabaseSafeOutputRowsSchema = z.array(SupabaseSafeOutputRowSchema).readonly();

export const SupabaseProductionEventRowSchema = z
  .strictObject({
    id: ProductionEventIdSchema,
    event_day_id: EventDayIdSchema,
    club_id: ClubIdSchema,
    court_id: CourtIdSchema,
    title: z.string().trim().min(1).max(200),
    scheduled_start_at: TimestampSchema,
    scheduled_end_at: TimestampSchema,
    status: ProductionEventStatusSchema,
    version: VersionSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .transform((row) => ProductionEventSchema.parse({
    id: row.id,
    eventDayId: row.event_day_id,
    clubId: row.club_id,
    courtId: row.court_id,
    title: row.title,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    status: row.status,
    version: row.version,
  }));

export const SupabaseDesiredOutputStateRowSchema = z
  .strictObject({
    output_id: OutputIdSchema,
    club_id: ClubIdSchema,
    event_id: ProductionEventIdSchema,
    version: VersionSchema,
    state: DesiredOutputSpecSchema,
    updated_by_principal_id: PrincipalIdSchema,
    command_id: CommandIdSchema,
    updated_at: TimestampSchema,
  })
  .transform((row) => DesiredOutputStateSchema.parse({
    outputId: row.output_id,
    clubId: row.club_id,
    eventId: row.event_id,
    version: row.version,
    desired: row.state,
    updatedByPrincipalId: row.updated_by_principal_id,
    commandId: row.command_id,
    updatedAt: row.updated_at,
  }));

export const SupabaseDesiredOutputStateRowsSchema = z
  .array(SupabaseDesiredOutputStateRowSchema)
  .readonly();

export const SupabaseObservedOutputStateRowSchema = z
  .strictObject({
    output_id: OutputIdSchema,
    agent_principal_id: PrincipalIdSchema,
    club_id: ClubIdSchema,
    event_id: ProductionEventIdSchema,
    sequence: SupabaseSequenceSchema,
    health: ObservedHealthSchema,
    state: JsonValueSchema,
    reported_at: TimestampSchema,
  })
  .transform((row) => ObservedOutputStateSchema.parse({ outputId: row.output_id, agentPrincipalId: row.agent_principal_id, clubId: row.club_id, eventId: row.event_id, sequence: row.sequence, health: row.health, state: row.state, reportedAt: row.reported_at }));

export const SupabaseObservedOutputStateRowsSchema = z
  .array(SupabaseObservedOutputStateRowSchema)
  .readonly();

export const SupabaseAssignedOutputSnapshotRowSchema = z
  .strictObject({
    output: SupabaseSafeOutputRowSchema,
    desired: SupabaseDesiredOutputStateRowSchema,
    observed: SupabaseObservedOutputStateRowSchema.nullable(),
  })
  .readonly();

export const SupabaseAssignedOutputSnapshotsSchema = z
  .array(SupabaseAssignedOutputSnapshotRowSchema)
  .readonly();

export const SupabaseOperationRowSchema = z.strictObject({ id: OperationIdSchema, club_id: ClubIdSchema, event_id: ProductionEventIdSchema, court_id: CourtIdSchema, output_id: OutputIdSchema.nullable(), command_id: CommandIdSchema, kind: OperationKindSchema, payload: OperationPayloadSchema, before_state: JsonValueSchema.nullable(), after_state: JsonValueSchema, requested_by_principal_id: PrincipalIdSchema, created_at: TimestampSchema }).transform((row) => OperationSchema.parse({ id: row.id, clubId: row.club_id, eventId: row.event_id, courtId: row.court_id, outputId: row.output_id, commandId: row.command_id, kind: row.kind, payload: row.payload, requestedByPrincipalId: row.requested_by_principal_id, createdAt: row.created_at }));

export const SupabaseClaimableOperationRowSchema = z
  .strictObject({
    id: OperationIdSchema,
    club_id: ClubIdSchema,
    event_id: ProductionEventIdSchema,
    court_id: CourtIdSchema,
    output_id: OutputIdSchema.nullable(),
    command_id: CommandIdSchema,
    kind: OperationKindSchema,
    payload: OperationPayloadSchema,
    requested_by_principal_id: PrincipalIdSchema,
    created_at: TimestampSchema,
  })
  .transform((row) => OperationSchema.parse({
    id: row.id,
    clubId: row.club_id,
    eventId: row.event_id,
    courtId: row.court_id,
    outputId: row.output_id,
    commandId: row.command_id,
    kind: row.kind,
    payload: row.payload,
    requestedByPrincipalId: row.requested_by_principal_id,
    createdAt: row.created_at,
  }));

export const SupabaseClaimableOperationsResultSchema = z
  .array(SupabaseClaimableOperationRowSchema)
  .readonly();

export const SupabaseOperationClaimRowSchema = z.strictObject({ operation_id: OperationIdSchema, agent_principal_id: PrincipalIdSchema, club_id: ClubIdSchema, status: OperationClaimStatusSchema, claimed_at: TimestampSchema, lease_expires_at: TimestampSchema, result: OperationResultSchema.nullable(), completed_at: TimestampSchema.nullable() }).transform((row) => OperationClaimSchema.parse({ operationId: row.operation_id, agentPrincipalId: row.agent_principal_id, status: row.status, claimedAt: row.claimed_at, leaseExpiresAt: row.lease_expires_at, result: row.result, completedAt: row.completed_at }));

const SupabaseOutputSecretRefSchema = z
  .strictObject({ id: OutputIdSchema, secretRef: LocalSecretRefSchema.nullable() })
  .readonly();
const SupabaseDeviceSecretRefSchema = z
  .strictObject({ id: DeviceIdSchema, secretRef: LocalSecretRefSchema })
  .readonly();

export const SupabaseAssignedSecretRefsSchema = z
  .strictObject({
    outputs: z.array(SupabaseOutputSecretRefSchema).readonly(),
    devices: z.array(SupabaseDeviceSecretRefSchema).readonly(),
  })
  .transform((refs) => ({
    outputs: refs.outputs.flatMap((ref) => ref.secretRef === null ? [] : [{
      id: ref.id,
      secretRef: ref.secretRef,
    }]),
    devices: refs.devices,
  }))
  .readonly();

export type SupabaseAssignedSecretRefs = z.infer<typeof SupabaseAssignedSecretRefsSchema>;

export const SupabaseAssetSpecRowSchema = z.strictObject({ id: AssetSpecIdSchema, club_id: ClubIdSchema, event_id: ProductionEventIdSchema, key: z.string(), version: VersionSchema, kind: AssetKindSchema, uri: z.string(), sha256: z.string(), media_type: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable(), duration_ms: z.number().int().nullable(), metadata: JsonValueSchema, created_at: TimestampSchema }).transform((row) => AssetSpecSchema.parse({ id: row.id, clubId: row.club_id, eventId: row.event_id, key: row.key, version: row.version, kind: row.kind, uri: row.uri, sha256: row.sha256, mediaType: row.media_type, width: row.width, height: row.height, durationMs: row.duration_ms, metadata: row.metadata }));
