import { describe, expect, it } from 'vitest';
import {
  RegisterAssetSpecCommandSchema,
  CompleteOperationCommandSchema,
  SetHumanRoleCommandSchema,
  SetDesiredStateCommandSchema,
  UpsertAssignmentCommandSchema,
  UpsertDeviceCommandSchema,
  UpsertEventDayCommandSchema,
  UpsertMachinePrincipalCommandSchema,
  UpsertOutputCommandSchema,
} from '../src/index.js';

const ids = {
  asset: '10000000-0000-4000-8000-000000000001',
  assignment: '20000000-0000-4000-8000-000000000001',
  authUser: '30000000-0000-4000-8000-000000000001',
  club: '40000000-0000-4000-8000-000000000001',
  court: '50000000-0000-4000-8000-000000000001',
  device: '60000000-0000-4000-8000-000000000001',
  event: '70000000-0000-4000-8000-000000000001',
  eventDay: '80000000-0000-4000-8000-000000000001',
  output: '90000000-0000-4000-8000-000000000001',
  principal: 'a0000000-0000-4000-8000-000000000001',
} as const;

const concurrency = { expectedVersion: 0, commandId: 'provision-1' } as const;
const profile = {
  courtId: ids.court,
  videoSourceDeviceId: ids.device,
  width: 1920,
  height: 1080,
  framesPerSecond: 30,
  videoBitrateKbps: 6000,
  audioSourceDeviceId: null,
  audioBitrateKbps: 160,
  overlayEnabled: true,
} as const;

describe('production provisioning commands', () => {
  it('parses a versioned event-day upsert', () => {
    // Given
    const command = { ...concurrency, eventDayId: ids.eventDay, clubId: ids.club, name: 'Finals', eventDate: '2026-09-09', timeZone: 'Europe/Madrid', status: 'active' };

    // When
    const parsed = UpsertEventDayCommandSchema.parse(command);

    // Then
    expect(parsed.status).toBe('active');
  });

  it('parses a versioned machine-principal upsert', () => {
    // Given
    const command = { ...concurrency, principalId: ids.principal, clubId: ids.club, authUserId: ids.authUser, kind: 'agent', displayName: 'Court agent', active: true };

    // When
    const parsed = UpsertMachinePrincipalCommandSchema.parse(command);

    // Then
    expect(parsed.kind).toBe('agent');
  });

  it('parses versioned device, output, and assignment upserts', () => {
    // Given
    const device = { ...concurrency, deviceId: ids.device, principalId: ids.principal, name: 'Encoder', kind: 'encoder', secretRef: 'local://devices/encoder', enabled: true };
    const output = { ...concurrency, outputId: ids.output, eventId: ids.event, name: 'Program', kind: 'program', transport: 'srt', secretRef: 'local://outputs/program', enabled: true };
    const assignment = { ...concurrency, assignmentId: ids.assignment, eventId: ids.event, principalId: ids.principal, role: 'agent', active: true };

    // When
    const parsedDevice = UpsertDeviceCommandSchema.parse(device);
    const parsedOutput = UpsertOutputCommandSchema.parse(output);
    const parsedAssignment = UpsertAssignmentCommandSchema.parse(assignment);

    // Then
    expect(parsedDevice.kind).toBe('encoder');
    expect(parsedOutput.transport).toBe('srt');
    expect(parsedAssignment.role).toBe('agent');
  });

  it('parses versioned immutable asset registration', () => {
    // Given
    const command = { ...concurrency, assetSpecId: ids.asset, eventId: ids.event, key: 'sponsor/main', kind: 'image', uri: 'asset://sponsor/main-v1', sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1920, height: 1080, durationMs: null, metadata: {} };

    // When
    const parsed = RegisterAssetSpecCommandSchema.parse(command);

    // Then
    expect(parsed.key).toBe('sponsor/main');
  });

  it('rejects literal device and output secrets', () => {
    // Given
    const device = { ...concurrency, deviceId: ids.device, principalId: ids.principal, name: 'Encoder', kind: 'encoder', secretRef: 'literal-password', enabled: true };
    const output = { ...concurrency, outputId: ids.output, eventId: ids.event, name: 'Program', kind: 'program', transport: 'srt', secretRef: 'literal-stream-key', enabled: true };

    // When
    const deviceResult = UpsertDeviceCommandSchema.safeParse(device);
    const outputResult = UpsertOutputCommandSchema.safeParse(output);

    // Then
    expect(deviceResult.success).toBe(false);
    expect(outputResult.success).toBe(false);
  });
});

describe('desired output commands', () => {
  it('parses an explicit running lifecycle and court program profile', () => {
    // Given
    const command = { ...concurrency, outputId: ids.output, desired: { lifecycle: 'running', profile }, operationKind: 'start', operationPayload: {} };

    // When
    const parsed = SetDesiredStateCommandSchema.parse(command);

    // Then
    expect(parsed.desired.lifecycle).toBe('running');
    expect(parsed.desired.profile.videoBitrateKbps).toBe(6000);
  });

  it('rejects arbitrary JSON desired state', () => {
    // Given
    const command = { ...concurrency, outputId: ids.output, desired: { running: true }, operationKind: 'start', operationPayload: {} };

    // When
    const result = SetDesiredStateCommandSchema.safeParse(command);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects untyped operation payload fields', () => {
    // Given
    const command = { ...concurrency, outputId: ids.output, desired: { lifecycle: 'running', profile }, operationKind: 'start', operationPayload: { executable: 'ffmpeg' } };

    // When
    const result = SetDesiredStateCommandSchema.safeParse(command);

    // Then
    expect(result.success).toBe(false);
  });
});

describe('agent completion and human RBAC commands', () => {
  it('accepts only terminal completion with a safe typed result', () => {
    const command = { operationId: ids.output, status: 'completed', result: { summary: 'Started program output', retryable: false } };
    expect(CompleteOperationCommandSchema.parse(command).status).toBe('completed');
    expect(CompleteOperationCommandSchema.safeParse({ ...command, status: 'claimed' }).success).toBe(false);
    expect(CompleteOperationCommandSchema.safeParse({ ...command, result: { executable: 'sh' } }).success).toBe(false);
  });

  it('limits human role commands to operator and viewer', () => {
    const command = { ...concurrency, principalId: ids.principal, role: 'operator', granted: true };
    expect(SetHumanRoleCommandSchema.parse(command).role).toBe('operator');
    expect(SetHumanRoleCommandSchema.safeParse({ ...command, role: 'production_admin' }).success).toBe(false);
  });
});
