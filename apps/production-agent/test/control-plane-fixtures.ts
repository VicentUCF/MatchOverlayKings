import { courtSnapshot } from './supervisor-fixtures.js';

export const AGENT_OPERATION_ID = '81000000-0000-4000-8000-000000000001';

export function assignedSnapshotRows() {
  const snapshot = courtSnapshot(0);
  return {
    output: {
      id: snapshot.output.id,
      club_id: snapshot.output.clubId,
      event_id: snapshot.output.eventId,
      court_id: snapshot.output.courtId,
      name: snapshot.output.name,
      kind: snapshot.output.kind,
      transport: snapshot.output.transport,
      enabled: snapshot.output.enabled,
      version: snapshot.output.version,
      created_at: snapshot.desired.updatedAt,
      updated_at: snapshot.desired.updatedAt,
    },
    desired: {
      output_id: snapshot.desired.outputId,
      club_id: snapshot.desired.clubId,
      event_id: snapshot.desired.eventId,
      version: snapshot.desired.version,
      state: snapshot.desired.desired,
      updated_by_principal_id: snapshot.desired.updatedByPrincipalId,
      command_id: snapshot.desired.commandId,
      updated_at: snapshot.desired.updatedAt,
    },
    observed: {
      output_id: snapshot.observed.outputId,
      agent_principal_id: snapshot.observed.agentPrincipalId,
      club_id: snapshot.observed.clubId,
      event_id: snapshot.observed.eventId,
      sequence: String(snapshot.observed.sequence),
      health: snapshot.observed.health,
      state: snapshot.observed.state,
      reported_at: snapshot.observed.reportedAt,
    },
    snapshot,
  };
}

export function operationRow() {
  const rows = assignedSnapshotRows();
  return {
    id: AGENT_OPERATION_ID,
    club_id: rows.snapshot.output.clubId,
    event_id: rows.snapshot.output.eventId,
    court_id: rows.snapshot.output.courtId,
    output_id: rows.snapshot.output.id,
    command_id: 'agent-operation-1',
    kind: 'reconcile',
    payload: {},
    requested_by_principal_id: rows.snapshot.desired.updatedByPrincipalId,
    created_at: rows.snapshot.desired.updatedAt,
  };
}

export function claimRow(status: 'claimed' | 'completed' | 'failed' = 'claimed') {
  const rows = assignedSnapshotRows();
  return {
    operation_id: AGENT_OPERATION_ID,
    agent_principal_id: rows.snapshot.observed.agentPrincipalId,
    club_id: rows.snapshot.output.clubId,
    status,
    claimed_at: rows.snapshot.observed.reportedAt,
    lease_expires_at: '2026-09-10T08:02:00Z',
    result: status === 'claimed' ? null : { summary: 'Applied', retryable: false },
    completed_at: status === 'claimed' ? null : '2026-09-10T08:01:30Z',
  };
}
