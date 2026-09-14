import type { ProductionProvisioningBackend } from './production-provisioning-adapter.js';

export const PROVISIONING_IDS = {
  assignment: '10000000-0000-4000-8000-000000000001',
  authUser: '20000000-0000-4000-8000-000000000001',
  club: '30000000-0000-4000-8000-000000000001',
  court: '40000000-0000-4000-8000-000000000001',
  device: '50000000-0000-4000-8000-000000000001',
  event: '60000000-0000-4000-8000-000000000001',
  eventDay: '70000000-0000-4000-8000-000000000001',
  output: '80000000-0000-4000-8000-000000000001',
  principal: '90000000-0000-4000-8000-000000000001',
} as const;

export const PROVISIONING_COMMAND_ID = 'provision-command';
export const PROVISIONING_TIMESTAMP = '2026-09-14T10:00:00.000Z';

export type ProvisioningRpcCall = {
  readonly name: string;
  readonly args: Record<string, unknown>;
};

export type ProvisioningHarness = {
  readonly backend: ProductionProvisioningBackend;
  readonly calls: readonly ProvisioningRpcCall[];
};

export function provisioningHarness(response: unknown): ProvisioningHarness {
  const calls: ProvisioningRpcCall[] = [];
  return {
    calls,
    backend: {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

export function eventDayRow(): Record<string, unknown> {
  return {
    id: PROVISIONING_IDS.eventDay,
    club_id: PROVISIONING_IDS.club,
    name: 'Finals',
    event_date: '2026-09-14',
    time_zone: 'Europe/Madrid',
    status: 'active',
    version: 1,
    created_at: PROVISIONING_TIMESTAMP,
    updated_at: PROVISIONING_TIMESTAMP,
  };
}

export function principalRow(): Record<string, unknown> {
  return {
    id: PROVISIONING_IDS.principal,
    club_id: PROVISIONING_IDS.club,
    auth_user_id: PROVISIONING_IDS.authUser,
    kind: 'agent',
    display_name: 'Production agent',
    active: true,
    version: 1,
    created_at: PROVISIONING_TIMESTAMP,
    updated_at: PROVISIONING_TIMESTAMP,
  };
}

export function deviceRow(): Record<string, unknown> {
  return {
    id: PROVISIONING_IDS.device,
    club_id: PROVISIONING_IDS.club,
    principal_id: PROVISIONING_IDS.principal,
    name: 'Court capture',
    kind: 'camera',
    enabled: true,
    last_heartbeat_at: null,
    heartbeat_status: {},
    version: 1,
    created_at: PROVISIONING_TIMESTAMP,
    updated_at: PROVISIONING_TIMESTAMP,
  };
}

export function eventRow(status = 'scheduled', version = 1): Record<string, unknown> {
  return {
    id: PROVISIONING_IDS.event,
    event_day_id: PROVISIONING_IDS.eventDay,
    club_id: PROVISIONING_IDS.club,
    court_id: PROVISIONING_IDS.court,
    title: 'Court 1 finals',
    scheduled_start_at: '2026-09-14T10:00:00.000Z',
    scheduled_end_at: '2026-09-14T12:00:00.000Z',
    status,
    version,
    created_at: PROVISIONING_TIMESTAMP,
    updated_at: PROVISIONING_TIMESTAMP,
  };
}

export function assignmentRow(): Record<string, unknown> {
  return {
    id: PROVISIONING_IDS.assignment,
    club_id: PROVISIONING_IDS.club,
    event_id: PROVISIONING_IDS.event,
    principal_id: PROVISIONING_IDS.principal,
    role: 'agent',
    active: true,
    version: 1,
    created_at: PROVISIONING_TIMESTAMP,
    updated_at: PROVISIONING_TIMESTAMP,
  };
}

export function outputRow(): Record<string, unknown> {
  return {
    id: PROVISIONING_IDS.output,
    club_id: PROVISIONING_IDS.club,
    event_id: PROVISIONING_IDS.event,
    court_id: PROVISIONING_IDS.court,
    name: 'Program',
    kind: 'program',
    transport: 'srt',
    enabled: true,
    version: 1,
    created_at: PROVISIONING_TIMESTAMP,
    updated_at: PROVISIONING_TIMESTAMP,
  };
}
