export const USER_ID = '10000000-0000-4000-8000-000000000001';
export const CLUB_ID = '20000000-0000-4000-8000-000000000001';
export const PRINCIPAL_ID = '30000000-0000-4000-8000-000000000001';
export const EVENT_ID = '40000000-0000-4000-8000-000000000001';
export const OUTPUT_ID = '50000000-0000-4000-8000-000000000001';
export const VIDEO_DEVICE_ID = '60000000-0000-4000-8000-000000000001';
export const AGENT_ID = '70000000-0000-4000-8000-000000000001';
export const OPERATION_ID = 'b0000000-0000-4000-8000-000000000001';

const timestamp = '2026-09-14T10:00:00.000Z';
const FIRST_COURT_ID = '80000000-0000-4000-8000-000000000001';

type OperationClaimRowFixture = {
  readonly operation_id: string;
  readonly agent_principal_id: string;
  readonly club_id: string;
  readonly status: 'claimed' | 'completed' | 'failed';
  readonly claimed_at: string;
  readonly lease_expires_at: string;
  readonly result: { readonly summary: string; readonly retryable: boolean } | null;
  readonly completed_at: string | null;
};

export function productionDataset(role: 'production_admin' | 'operator' | 'viewer' = 'operator') {
  const courts = ['pista-1', 'pista-2', 'pista-3', 'pista-4'].map((slug, index) => ({
    id: `80000000-0000-4000-8000-00000000000${index + 1}`,
    club_id: CLUB_ID,
    slug,
    name: `Pista ${index + 1}`,
    display_order: index + 1,
    production_enabled: true,
  }));
  const profile = {
    courtId: FIRST_COURT_ID,
    videoSourceDeviceId: VIDEO_DEVICE_ID,
    width: 1920,
    height: 1080,
    framesPerSecond: 50,
    videoBitrateKbps: 8_000,
    audioSourceDeviceId: null,
    audioBitrateKbps: 192,
    overlayEnabled: true,
  };
  const operationClaims: OperationClaimRowFixture[] = [{
    operation_id: OPERATION_ID,
    agent_principal_id: AGENT_ID,
    club_id: CLUB_ID,
    status: 'claimed',
    claimed_at: timestamp,
    lease_expires_at: '2026-09-14T10:05:00.000Z',
    result: null,
    completed_at: null,
  }];

  return {
    production_principals: [{
      id: PRINCIPAL_ID,
      club_id: CLUB_ID,
      auth_user_id: USER_ID,
      kind: 'human',
      display_name: 'Production user',
      active: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }],
    production_principal_roles: [{ principal_id: PRINCIPAL_ID, club_id: CLUB_ID, role, created_at: timestamp }],
    courts,
    production_assignments: [{
      id: '90000000-0000-4000-8000-000000000001',
      club_id: CLUB_ID,
      event_id: EVENT_ID,
      principal_id: PRINCIPAL_ID,
      role: role === 'production_admin' ? 'operator' : role,
      active: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }],
    production_events: [{
      id: EVENT_ID,
      event_day_id: 'a0000000-0000-4000-8000-000000000001',
      club_id: CLUB_ID,
      court_id: FIRST_COURT_ID,
      title: 'Final KPL',
      scheduled_start_at: '2026-09-14T09:00:00.000Z',
      scheduled_end_at: '2026-09-14T12:00:00.000Z',
      status: 'live',
      version: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }],
    production_outputs: [{
      id: OUTPUT_ID,
      club_id: CLUB_ID,
      event_id: EVENT_ID,
      court_id: FIRST_COURT_ID,
      name: 'Program',
      kind: 'program',
      transport: 'srt',
      enabled: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }],
    production_desired_states: [{
      output_id: OUTPUT_ID,
      club_id: CLUB_ID,
      event_id: EVENT_ID,
      version: 3,
      state: { lifecycle: 'running', profile },
      updated_by_principal_id: PRINCIPAL_ID,
      command_id: 'desired-command',
      updated_at: timestamp,
    }],
    production_observed_states: [{
      output_id: OUTPUT_ID,
      agent_principal_id: AGENT_ID,
      club_id: CLUB_ID,
      event_id: EVENT_ID,
      sequence: '8',
      health: 'healthy',
      state: { lifecycle: 'running', appliedDesiredVersion: 3 },
      reported_at: timestamp,
    }],
    production_operations: [{
      id: OPERATION_ID,
      club_id: CLUB_ID,
      event_id: EVENT_ID,
      court_id: FIRST_COURT_ID,
      output_id: OUTPUT_ID,
      command_id: 'desired-command',
      kind: 'reconcile',
      payload: {},
      before_state: null,
      after_state: {},
      requested_by_principal_id: PRINCIPAL_ID,
      created_at: timestamp,
    }],
    production_operation_claims: operationClaims,
    score_states: [{
      club_id: CLUB_ID,
      court_slug: 'pista-1',
      title: 'Final KPL',
      home_team_id: 'home',
      away_team_id: 'away',
      status: 'live',
      version: 9,
      updated_at: timestamp,
    }],
  };
}
