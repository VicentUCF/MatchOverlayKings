import { describe, expect, it } from 'vitest';
import {
  SupabaseAssignedOutputSnapshotsSchema,
  SupabaseAssignedSecretRefsSchema,
  SupabaseClaimableOperationsResultSchema,
  SupabaseObservedOutputStateRowSchema,
} from '../src/index.js';

const ids = {
  club: '00000000-0000-4000-8000-000000000001',
  event: '20000000-0000-4000-8000-000000000001',
  court: '30000000-0000-4000-8000-000000000001',
  principal: '40000000-0000-4000-8000-000000000001',
  device: '60000000-0000-4000-8000-000000000001',
  output: '70000000-0000-4000-8000-000000000001',
  operation: '80000000-0000-4000-8000-000000000001',
} as const;

const instant = '2026-09-09T10:00:00.000Z';

function claimableOperationRow() {
  return {
    id: ids.operation,
    club_id: ids.club,
    event_id: ids.event,
    court_id: ids.court,
    output_id: ids.output,
    command_id: 'operation-1',
    kind: 'reconcile',
    payload: {},
    requested_by_principal_id: ids.principal,
    created_at: instant,
  };
}

function assignedSnapshotRow() {
  return {
    output: {
      id: ids.output,
      club_id: ids.club,
      event_id: ids.event,
      court_id: ids.court,
      name: 'Program',
      kind: 'program',
      transport: 'local',
      enabled: true,
      version: 1,
      created_at: instant,
      updated_at: instant,
    },
    desired: {
      output_id: ids.output,
      club_id: ids.club,
      event_id: ids.event,
      version: 1,
      state: {
        lifecycle: 'preflight',
        profile: {
          courtId: ids.court,
          videoSourceDeviceId: ids.device,
          width: 1920,
          height: 1080,
          framesPerSecond: 50,
          videoBitrateKbps: 8_000,
          audioSourceDeviceId: null,
          audioBitrateKbps: 192,
          overlayEnabled: true,
        },
      },
      updated_by_principal_id: ids.principal,
      command_id: 'desired-1',
      updated_at: instant,
    },
    observed: null,
  };
}

describe('Supabase agent wire contracts', () => {
  it('parses strict nested assigned snapshot rows', () => {
    const row = assignedSnapshotRow();

    const parsed = SupabaseAssignedOutputSnapshotsSchema.parse([row]);

    expect(parsed[0]).toMatchObject({
      output: { id: ids.output },
      desired: { outputId: ids.output },
      observed: null,
    });
    expect(SupabaseAssignedOutputSnapshotsSchema.safeParse([
      { ...row, secret_ref: 'local://hidden' },
    ]).success).toBe(false);
  });

  it('omits null output secret refs while rejecting non-local values', () => {
    const value = {
      outputs: [
        { id: ids.output, secretRef: null },
        { id: '70000000-0000-4000-8000-000000000002', secretRef: 'local://outputs/program' },
      ],
      devices: [],
    };

    expect(SupabaseAssignedSecretRefsSchema.parse(value).outputs).toEqual([
      { id: '70000000-0000-4000-8000-000000000002', secretRef: 'local://outputs/program' },
    ]);
    expect(SupabaseAssignedSecretRefsSchema.safeParse({
      ...value,
      outputs: [{ id: ids.output, secretRef: 'https://secret.example' }],
    }).success).toBe(false);
  });

  it('parses claimable operation rows into canonical operations', () => {
    const parsed = SupabaseClaimableOperationsResultSchema.parse([claimableOperationRow()]);

    expect(parsed).toEqual([{
      id: ids.operation,
      clubId: ids.club,
      eventId: ids.event,
      courtId: ids.court,
      outputId: ids.output,
      commandId: 'operation-1',
      kind: 'reconcile',
      payload: {},
      requestedByPrincipalId: ids.principal,
      createdAt: instant,
    }]);
  });

  it('rejects malformed and overexposed claimable operation rows', () => {
    const row = claimableOperationRow();

    expect(SupabaseClaimableOperationsResultSchema.safeParse([
      { ...row, before_state: { secretRef: 'local://hidden' } },
    ]).success).toBe(false);
    expect(SupabaseClaimableOperationsResultSchema.safeParse([
      { ...row, payload: { arbitrary: true } },
    ]).success).toBe(false);
    expect(SupabaseClaimableOperationsResultSchema.safeParse([
      { ...row, id: 'not-an-operation-id' },
    ]).success).toBe(false);
  });

  it('normalizes safe bigint sequence strings and rejects unsafe values', () => {
    const row = {
      output_id: ids.output,
      agent_principal_id: ids.principal,
      club_id: ids.club,
      event_id: ids.event,
      sequence: '42',
      health: 'healthy',
      state: {},
      reported_at: instant,
    };

    expect(SupabaseObservedOutputStateRowSchema.parse(row).sequence).toBe(42);
    expect(SupabaseObservedOutputStateRowSchema.safeParse({
      ...row,
      sequence: '9007199254740992',
    }).success).toBe(false);
  });
});
