import { describe, expect, it } from 'vitest';
import { createProductionProvisioningAdapter } from './production-provisioning-adapter.js';
import {
  assignmentRow,
  deviceRow,
  eventDayRow,
  eventRow,
  outputRow,
  principalRow,
  PROVISIONING_COMMAND_ID,
  PROVISIONING_IDS,
  provisioningHarness,
} from './production-provisioning-test-fixtures.js';

const commandId = () => PROVISIONING_COMMAND_ID;
const response = (data: unknown) => ({ data, error: null });

describe('production provisioning RPC adapter', () => {
  it('upserts an event day through the exact versioned RPC', async () => {
    // Given
    const harness = provisioningHarness(response(eventDayRow()));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.upsertEventDay({
      eventDayId: PROVISIONING_IDS.eventDay,
      clubId: PROVISIONING_IDS.club,
      name: 'Finals',
      eventDate: '2026-09-14',
      timeZone: 'Europe/Madrid',
      status: 'active',
      expectedVersion: 0,
    });

    // Then
    expect(harness.calls).toEqual([{
      name: 'production_upsert_event_day_v1',
      args: {
        p_club_id: PROVISIONING_IDS.club,
        p_event_day_id: PROVISIONING_IDS.eventDay,
        p_name: 'Finals',
        p_event_date: '2026-09-14',
        p_time_zone: 'Europe/Madrid',
        p_status: 'active',
        p_expected_version: 0,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    }]);
    expect(result).toMatchObject({ kind: 'accepted', value: { status: 'active', version: 1 } });
  });

  it('registers a pre-existing Auth user as a machine principal', async () => {
    // Given
    const harness = provisioningHarness(response(principalRow()));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.upsertMachinePrincipal({
      principalId: PROVISIONING_IDS.principal,
      clubId: PROVISIONING_IDS.club,
      authUserId: PROVISIONING_IDS.authUser,
      kind: 'agent',
      displayName: 'Production agent',
      active: true,
      expectedVersion: 0,
    });

    // Then
    expect(harness.calls[0]).toEqual({
      name: 'production_upsert_machine_principal_v1',
      args: {
        p_principal_id: PROVISIONING_IDS.principal,
        p_club_id: PROVISIONING_IDS.club,
        p_auth_user_id: PROVISIONING_IDS.authUser,
        p_kind: 'agent',
        p_display_name: 'Production agent',
        p_active: true,
        p_expected_version: 0,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    });
    expect(result).toMatchObject({ kind: 'accepted', value: { kind: 'agent' } });
  });

  it('registers a capture device without returning its local secret reference', async () => {
    // Given
    const harness = provisioningHarness(response(deviceRow()));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.upsertDevice({
      deviceId: PROVISIONING_IDS.device,
      principalId: PROVISIONING_IDS.principal,
      name: 'Court capture',
      kind: 'camera',
      secretRef: 'local://devices/court-1',
      enabled: true,
      expectedVersion: 0,
    });

    // Then
    expect(harness.calls[0]).toEqual({
      name: 'production_upsert_device_v1',
      args: {
        p_device_id: PROVISIONING_IDS.device,
        p_principal_id: PROVISIONING_IDS.principal,
        p_name: 'Court capture',
        p_kind: 'camera',
        p_secret_ref: 'local://devices/court-1',
        p_enabled: true,
        p_expected_version: 0,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    });
    expect(result).toMatchObject({ kind: 'accepted', value: { kind: 'camera' } });
    expect(result).not.toHaveProperty('value.secretRef');
  });

  it('schedules an event through the court-slug RPC', async () => {
    // Given
    const harness = provisioningHarness(response(eventRow()));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.scheduleEvent({
      eventId: PROVISIONING_IDS.event,
      eventDayId: PROVISIONING_IDS.eventDay,
      courtSlug: 'pista-1',
      title: 'Court 1 finals',
      scheduledStartAt: '2026-09-14T10:00:00.000Z',
      scheduledEndAt: '2026-09-14T12:00:00.000Z',
      expectedVersion: 0,
    });

    // Then
    expect(harness.calls[0]).toEqual({
      name: 'production_schedule_event_v1',
      args: {
        p_event_id: PROVISIONING_IDS.event,
        p_event_day_id: PROVISIONING_IDS.eventDay,
        p_court_slug: 'pista-1',
        p_title: 'Court 1 finals',
        p_scheduled_start_at: '2026-09-14T10:00:00.000Z',
        p_scheduled_end_at: '2026-09-14T12:00:00.000Z',
        p_expected_version: 0,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    });
    expect(result).toMatchObject({ kind: 'accepted', value: { status: 'scheduled' } });
  });

  it('assigns the shared agent to an event', async () => {
    // Given
    const harness = provisioningHarness(response(assignmentRow()));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.upsertAssignment({
      assignmentId: PROVISIONING_IDS.assignment,
      eventId: PROVISIONING_IDS.event,
      principalId: PROVISIONING_IDS.principal,
      role: 'agent',
      active: true,
      expectedVersion: 0,
    });

    // Then
    expect(harness.calls[0]).toEqual({
      name: 'production_upsert_assignment_v1',
      args: {
        p_assignment_id: PROVISIONING_IDS.assignment,
        p_event_id: PROVISIONING_IDS.event,
        p_principal_id: PROVISIONING_IDS.principal,
        p_role: 'agent',
        p_active: true,
        p_expected_version: 0,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    });
    expect(result).toMatchObject({ kind: 'accepted', value: { role: 'agent' } });
  });

  it('creates only an SRT program output and parses the redacted row', async () => {
    // Given
    const harness = provisioningHarness(response(outputRow()));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.upsertOutput({
      outputId: PROVISIONING_IDS.output,
      eventId: PROVISIONING_IDS.event,
      name: 'Program',
      kind: 'program',
      transport: 'srt',
      secretRef: 'local://outputs/court-1',
      enabled: true,
      expectedVersion: 0,
    });

    // Then
    expect(harness.calls[0]).toEqual({
      name: 'production_upsert_output_v1',
      args: {
        p_output_id: PROVISIONING_IDS.output,
        p_event_id: PROVISIONING_IDS.event,
        p_name: 'Program',
        p_kind: 'program',
        p_transport: 'srt',
        p_secret_ref: 'local://outputs/court-1',
        p_enabled: true,
        p_expected_version: 0,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    });
    expect(result).toMatchObject({ kind: 'accepted', value: { kind: 'program', transport: 'srt' } });
    expect(result).not.toHaveProperty('value.secretRef');
  });

  it('transitions event status through the exact versioned RPC', async () => {
    // Given
    const harness = provisioningHarness(response(eventRow('ready', 2)));
    const adapter = createProductionProvisioningAdapter(harness.backend, commandId);

    // When
    const result = await adapter.setEventStatus({
      eventId: PROVISIONING_IDS.event,
      status: 'ready',
      expectedVersion: 1,
    });

    // Then
    expect(harness.calls[0]).toEqual({
      name: 'production_set_event_status_v1',
      args: {
        p_event_id: PROVISIONING_IDS.event,
        p_status: 'ready',
        p_expected_version: 1,
        p_command_id: PROVISIONING_COMMAND_ID,
      },
    });
    expect(result).toMatchObject({ kind: 'accepted', value: { status: 'ready', version: 2 } });
  });
});
