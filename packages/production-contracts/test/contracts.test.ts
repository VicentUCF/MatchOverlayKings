import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AssetSpecSchema,
  DesiredOutputStateSchema,
  DeviceSchema,
  HumanCommandSchema,
  ObservedOutputStateSchema,
  OperationSchema,
  OutputSchema,
  PrincipalSchema,
  ProductionAssignmentSchema,
  ProductionEventDaySchema,
  ProductionEventSchema,
  SupabaseDesiredOutputStateRowSchema,
  SupabaseSafeOutputRowSchema,
  SupabaseProductionEventRowSchema,
  type ProductionEvent,
} from '../src/index.js';

const ids = {
  club: '00000000-0000-4000-8000-000000000001',
  eventDay: '10000000-0000-4000-8000-000000000001',
  event: '20000000-0000-4000-8000-000000000001',
  court: '30000000-0000-4000-8000-000000000001',
  principal: '40000000-0000-4000-8000-000000000001',
  device: '50000000-0000-4000-8000-000000000001',
  assignment: '60000000-0000-4000-8000-000000000001',
  output: '70000000-0000-4000-8000-000000000001',
  operation: '80000000-0000-4000-8000-000000000001',
  asset: '90000000-0000-4000-8000-000000000001',
} as const;

const instant = '2026-09-09T10:00:00.000Z';

describe('production scheduling contracts', () => {
  it('parses an event day and scheduled event when the window is ordered', () => {
    // Given
    const eventDay = { id: ids.eventDay, clubId: ids.club, name: 'Finals', eventDate: '2026-09-09', timeZone: 'Europe/Madrid', status: 'active', version: 1 };
    const event = { id: ids.event, eventDayId: ids.eventDay, clubId: ids.club, courtId: ids.court, title: 'Final', scheduledStartAt: instant, scheduledEndAt: '2026-09-09T12:00:00.000Z', status: 'scheduled', version: 1 };

    // When
    const parsedDay = ProductionEventDaySchema.parse(eventDay);
    const parsedEvent = ProductionEventSchema.parse(event);

    // Then
    expect(parsedDay.eventDate).toBe('2026-09-09');
    expect(parsedEvent.status).toBe('scheduled');
    expect(Object.isFrozen(parsedEvent)).toBe(true);
    expectTypeOf(parsedEvent).toEqualTypeOf<ProductionEvent>();
  });

  it('rejects an event when its end is not after its start', () => {
    // Given
    const event = { id: ids.event, eventDayId: ids.eventDay, clubId: ids.club, courtId: ids.court, title: 'Final', scheduledStartAt: instant, scheduledEndAt: instant, status: 'scheduled', version: 1 };

    // When
    const result = ProductionEventSchema.safeParse(event);

    // Then
    expect(result.success).toBe(false);
  });
});

describe('Supabase wire contracts', () => {
  it('transforms literal snake-case RPC rows into canonical domain models', () => {
    const eventRow = { id: ids.event, event_day_id: ids.eventDay, club_id: ids.club, court_id: ids.court, title: 'Final', scheduled_start_at: instant, scheduled_end_at: '2026-09-09T12:00:00.000Z', status: 'scheduled', version: 1, created_at: instant, updated_at: instant };
    const desiredRow = { output_id: ids.output, club_id: ids.club, event_id: ids.event, version: 1, state: { lifecycle: 'off', profile: { courtId: ids.court, videoSourceDeviceId: ids.device, width: 1920, height: 1080, framesPerSecond: 30, videoBitrateKbps: 6000, audioSourceDeviceId: null, audioBitrateKbps: 160, overlayEnabled: true } }, updated_at: instant, updated_by_principal_id: ids.principal, command_id: 'wire-1' };

    expect(SupabaseProductionEventRowSchema.parse(eventRow)).toEqual({ id: ids.event, eventDayId: ids.eventDay, clubId: ids.club, courtId: ids.court, title: 'Final', scheduledStartAt: instant, scheduledEndAt: '2026-09-09T12:00:00.000Z', status: 'scheduled', version: 1 });
    expect(SupabaseDesiredOutputStateRowSchema.parse(desiredRow).desired.lifecycle).toBe('off');
    expect(SupabaseSafeOutputRowSchema.parse({ id: ids.output, club_id: ids.club, event_id: ids.event, court_id: ids.court, name: 'Program', kind: 'program', transport: 'srt', enabled: true, version: 1, created_at: instant, updated_at: instant }).eventId).toBe(ids.event);
  });

  it('rejects SQL and JSON null desired lifecycles', () => {
    const base = { output_id: ids.output, club_id: ids.club, event_id: ids.event, version: 1, state: { lifecycle: null, profile: {} }, updated_at: instant, updated_by_principal_id: ids.principal, command_id: 'wire-null' };
    expect(SupabaseDesiredOutputStateRowSchema.safeParse(base).success).toBe(false);
    expect(SupabaseDesiredOutputStateRowSchema.safeParse({ ...base, state: null }).success).toBe(false);
  });
});

describe('production identity contracts', () => {
  it('keeps principal, device, and assignment identities distinct', () => {
    // Given
    const principal = { id: ids.principal, clubId: ids.club, kind: 'agent', displayName: 'Court agent', active: true, version: 1 };
    const device = { id: ids.device, clubId: ids.club, principalId: ids.principal, name: 'Encoder 1', kind: 'encoder', enabled: true, lastHeartbeatAt: null, version: 1 };
    const assignment = { id: ids.assignment, eventId: ids.event, principalId: ids.principal, role: 'agent', active: true, version: 1 };

    // When
    const parsedPrincipal = PrincipalSchema.parse(principal);
    const parsedDevice = DeviceSchema.parse(device);
    const parsedAssignment = ProductionAssignmentSchema.parse(assignment);

    // Then
    expect(parsedPrincipal.kind).toBe('agent');
    expect(parsedDevice.enabled).toBe(true);
    expect(parsedAssignment.role).toBe('agent');
  });

  it('rejects secret references from general device reads', () => {
    // Given
    const device = { id: ids.device, clubId: ids.club, principalId: ids.principal, name: 'Encoder 1', kind: 'encoder', secretRef: 'local://devices/encoder', enabled: true, lastHeartbeatAt: null, version: 1 };

    // When
    const result = DeviceSchema.safeParse(device);

    // Then
    expect(result.success).toBe(false);
  });
});

describe('production state and operation contracts', () => {
  it('parses output desired state, explicit unknown observation, and immutable operation', () => {
    // Given
    const output = { id: ids.output, eventId: ids.event, clubId: ids.club, courtId: ids.court, name: 'Program', kind: 'program', transport: 'srt', enabled: true, version: 1 };
    const desired = { outputId: ids.output, clubId: ids.club, eventId: ids.event, version: 2, desired: { lifecycle: 'running', profile: { courtId: ids.court, videoSourceDeviceId: ids.device, width: 1920, height: 1080, framesPerSecond: 30, videoBitrateKbps: 6000, audioSourceDeviceId: null, audioBitrateKbps: 160, overlayEnabled: true } }, updatedAt: instant, updatedByPrincipalId: ids.principal, commandId: 'desired-2' };
    const observed = { outputId: ids.output, clubId: ids.club, eventId: ids.event, agentPrincipalId: ids.principal, sequence: 3, health: 'unknown', state: {}, reportedAt: instant };
    const operation = { id: ids.operation, clubId: ids.club, eventId: ids.event, courtId: ids.court, outputId: ids.output, commandId: 'desired-2', kind: 'reconcile', payload: {}, requestedByPrincipalId: ids.principal, createdAt: instant };

    // When
    const parsedOutput = OutputSchema.parse(output);
    const parsedDesired = DesiredOutputStateSchema.parse(desired);
    const parsedObserved = ObservedOutputStateSchema.parse(observed);
    const parsedOperation = OperationSchema.parse(operation);

    // Then
    expect(parsedOutput.transport).toBe('srt');
    expect(parsedDesired.version).toBe(2);
    expect(parsedObserved.health).toBe('unknown');
    expect(Object.isFrozen(parsedOperation)).toBe(true);
  });

  it('requires optimistic versioning and an idempotency key for human commands', () => {
    // Given
    const incompleteCommand = { expectedVersion: 1 };

    // When
    const result = HumanCommandSchema.safeParse(incompleteCommand);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields at the package boundary', () => {
    // Given
    const command = { expectedVersion: 1, commandId: 'command-1', ignored: true };

    // When
    const result = HumanCommandSchema.safeParse(command);

    // Then
    expect(result.success).toBe(false);
  });
});

describe('production asset contracts', () => {
  it('parses immutable content-addressed asset specifications', () => {
    // Given
    const asset = { id: ids.asset, clubId: ids.club, eventId: ids.event, key: 'sponsor/main', version: 1, kind: 'image', uri: 'asset://sponsor/main-v1', sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1920, height: 1080, durationMs: null, metadata: {} };

    // When
    const parsed = AssetSpecSchema.parse(asset);

    // Then
    expect(parsed.sha256).toHaveLength(64);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
