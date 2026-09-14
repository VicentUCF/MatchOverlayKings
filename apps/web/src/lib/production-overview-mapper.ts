import { z } from 'zod';
import {
  AssignmentRoleSchema,
  ClubIdSchema,
  CourtIdSchema,
  CourtSlugSchema,
  PrincipalIdSchema,
  PrincipalKindSchema,
  PrincipalRoleSchema,
  SupabaseAssignmentRowSchema,
  SupabaseDesiredOutputStateRowsSchema,
  SupabaseObservedOutputStateRowsSchema,
  SupabaseOperationClaimRowSchema,
  SupabaseOperationRowSchema,
  SupabaseProductionEventRowSchema,
  SupabaseSafeOutputRowsSchema,
  TimestampSchema,
  VersionSchema,
} from '@kpl/production-contracts';
import {
  PRODUCTION_COURT_SLUGS,
  type ProductionCourtAssignment,
  type ProductionCourtSlot,
  type ProductionOverviewSnapshot,
} from './production-overview-types.js';

const PrincipalRowSchema = z.strictObject({
  id: PrincipalIdSchema,
  club_id: ClubIdSchema,
  auth_user_id: z.uuid(),
  kind: PrincipalKindSchema,
  display_name: z.string().trim().min(1),
  active: z.boolean(),
  version: VersionSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
const RoleRowSchema = z.strictObject({
  principal_id: PrincipalIdSchema,
  club_id: ClubIdSchema,
  role: PrincipalRoleSchema,
  created_at: TimestampSchema,
});
const CourtRowSchema = z.strictObject({
  id: CourtIdSchema,
  club_id: ClubIdSchema,
  slug: CourtSlugSchema,
  name: z.string().trim().min(1),
  display_order: z.number().int(),
  production_enabled: z.boolean(),
});
const AssignmentRowSchema = z.strictObject({
  id: z.uuid(),
  club_id: ClubIdSchema,
  event_id: z.uuid(),
  principal_id: PrincipalIdSchema,
  role: AssignmentRoleSchema,
  active: z.boolean(),
  version: VersionSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
const ScoreRowSchema = z.strictObject({
  club_id: ClubIdSchema,
  court_slug: CourtSlugSchema,
  title: z.string(),
  home_team_id: z.string(),
  away_team_id: z.string(),
  status: z.enum(['pre_match', 'live', 'finished']),
  version: VersionSchema,
  updated_at: TimestampSchema,
});
const ClubScopedOperationClaimRowSchema = SupabaseOperationClaimRowSchema
  .and(z.object({ club_id: ClubIdSchema }))
  .transform(({ club_id, ...claim }) => Object.freeze({
    clubId: club_id,
    claim: Object.freeze(claim),
  }));
const DatasetSchema = z.strictObject({
  production_principals: z.array(PrincipalRowSchema).readonly(),
  production_principal_roles: z.array(RoleRowSchema).readonly(),
  courts: z.array(CourtRowSchema).readonly(),
  production_assignments: z.array(AssignmentRowSchema).readonly(),
  production_events: z.array(SupabaseProductionEventRowSchema).readonly(),
  production_outputs: SupabaseSafeOutputRowsSchema,
  production_desired_states: SupabaseDesiredOutputStateRowsSchema,
  production_observed_states: SupabaseObservedOutputStateRowsSchema,
  production_operations: z.array(SupabaseOperationRowSchema).readonly(),
  production_operation_claims: z.array(ClubScopedOperationClaimRowSchema).readonly(),
  score_states: z.array(ScoreRowSchema).readonly(),
});

export type ProductionIdentityResult =
  | { readonly kind: 'success'; readonly clubId: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'malformed' };

export function resolveProductionIdentity(userId: string, input: unknown): ProductionIdentityResult {
  const parsedUserId = z.uuid().safeParse(userId);
  const parsedRows = z.array(PrincipalRowSchema).readonly().safeParse(input);
  if (!parsedUserId.success || !parsedRows.success) return { kind: 'malformed' };
  const matches = parsedRows.data.filter((row) => row.auth_user_id === parsedUserId.data);
  if (matches.length !== 1) return matches.length === 0 ? { kind: 'forbidden' } : { kind: 'malformed' };
  const principal = matches[0];
  if (principal === undefined) return { kind: 'malformed' };
  if (!principal.active || principal.kind !== 'human') return { kind: 'forbidden' };
  return { kind: 'success', clubId: principal.club_id };
}

export type ProductionMappingResult =
  | { readonly kind: 'success'; readonly capability: 'admin' | 'operator' | 'viewer'; readonly snapshot: ProductionOverviewSnapshot }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'malformed' };

export function mapProductionOverviewData(userId: string, input: unknown): ProductionMappingResult {
  const parsed = DatasetSchema.safeParse(input);
  if (!parsed.success) return { kind: 'malformed' };
  const identity = resolveProductionIdentity(userId, parsed.data.production_principals);
  if (identity.kind !== 'success') return identity;
  const principal = parsed.data.production_principals.find((row) => row.auth_user_id === userId);
  if (principal === undefined) return { kind: 'malformed' };
  if (!allRowsBelongToClub(parsed.data, identity.clubId)) return { kind: 'malformed' };
  const ownRoles = parsed.data.production_principal_roles
    .filter((row) => row.principal_id === principal.id)
    .map((row) => row.role);
  const ownAssignments = parsed.data.production_assignments
    .filter((row) => row.principal_id === principal.id && row.active);
  const capability = ownRoles.includes('production_admin')
    ? 'admin'
    : ownRoles.includes('operator')
      ? 'operator'
    : ownRoles.includes('viewer') || ownAssignments.some((row) => row.role === 'operator' || row.role === 'viewer')
      ? 'viewer'
      : null;
  if (capability === null) return { kind: 'forbidden' };
  const courtRows = PRODUCTION_COURT_SLUGS.map((slug) => parsed.data.courts.find((court) => court.slug === slug));
  if (courtRows.some((court) => court === undefined)) return { kind: 'malformed' };
  const [first, second, third, fourth] = courtRows;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return { kind: 'malformed' };
  const courts = Object.freeze([
    mapCourt(first, parsed.data, principal.id),
    mapCourt(second, parsed.data, principal.id),
    mapCourt(third, parsed.data, principal.id),
    mapCourt(fourth, parsed.data, principal.id),
  ] as const);
  return {
    kind: 'success',
    capability,
    snapshot: Object.freeze({
      clubId: ClubIdSchema.parse(identity.clubId),
      principalId: principal.id,
      courts,
      loadedAt: new Date().toISOString(),
    }),
  };
}

type ParsedDataset = z.infer<typeof DatasetSchema>;
type CourtRow = z.infer<typeof CourtRowSchema>;

function mapCourt(court: CourtRow, data: ParsedDataset, principalId: string): ProductionCourtSlot {
  const event = data.production_events
    .filter((candidate) => candidate.courtId === court.id && !['completed', 'cancelled'].includes(candidate.status))
    .sort((left, right) => eventRank(right.status) - eventRank(left.status)
      || Date.parse(right.scheduledStartAt) - Date.parse(left.scheduledStartAt))[0];
  const output = event === undefined ? undefined : data.production_outputs
    .find((candidate) => candidate.eventId === event.id && candidate.kind === 'program' && candidate.enabled);
  const desired = output === undefined ? undefined : data.production_desired_states
    .find((candidate) => candidate.outputId === output.id);
  let assignment: ProductionCourtAssignment | null = null;
  if (event !== undefined && output !== undefined && desired !== undefined) {
    const observed = data.production_observed_states
      .filter((candidate) => candidate.outputId === output.id)
      .sort((left, right) => Date.parse(right.reportedAt) - Date.parse(left.reportedAt))[0] ?? null;
    const latestOperation = data.production_operations
      .filter((candidate) => candidate.outputId === output.id)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
        || right.id.localeCompare(left.id))[0] ?? null;
    const latestOperationClaim = latestOperation === null
      ? null
      : data.production_operation_claims
        .find((candidate) => candidate.claim.operationId === latestOperation.id)?.claim ?? null;
    const rawViewerAssignment = data.production_assignments
      .find((candidate) => candidate.event_id === event.id && candidate.principal_id === principalId && candidate.active);
    const viewerAssignment = rawViewerAssignment === undefined ? null : SupabaseAssignmentRowSchema.parse(rawViewerAssignment);
    const scoreRow = data.score_states.find((candidate) => candidate.court_slug === court.slug);
    assignment = Object.freeze({
      event,
      output,
      desired,
      observed,
      latestOperation,
      latestOperationClaim,
      viewerAssignment,
      score: scoreRow === undefined ? null : Object.freeze({
        title: scoreRow.title,
        homeTeamId: scoreRow.home_team_id,
        awayTeamId: scoreRow.away_team_id,
        status: scoreRow.status,
        version: scoreRow.version,
        updatedAt: scoreRow.updated_at,
      }),
    });
  }
  return Object.freeze({
    slug: z.enum(PRODUCTION_COURT_SLUGS).parse(court.slug),
    courtId: court.id,
    name: court.name,
    productionEnabled: court.production_enabled,
    assignment,
  });
}

function eventRank(status: string): number {
  return status === 'live' ? 3 : status === 'ready' ? 2 : 1;
}

function allRowsBelongToClub(data: ParsedDataset, clubId: string): boolean {
  return data.production_principals.every((row) => row.club_id === clubId)
    && data.production_principal_roles.every((row) => row.club_id === clubId)
    && data.courts.every((row) => row.club_id === clubId)
    && data.production_assignments.every((row) => row.club_id === clubId)
    && data.production_events.every((row) => row.clubId === clubId)
    && data.production_outputs.every((row) => row.clubId === clubId)
    && data.production_desired_states.every((row) => row.clubId === clubId)
    && data.production_observed_states.every((row) => row.clubId === clubId)
    && data.production_operations.every((row) => row.clubId === clubId)
    && data.production_operation_claims.every((row) => row.clubId === clubId)
    && data.score_states.every((row) => row.club_id === clubId);
}
