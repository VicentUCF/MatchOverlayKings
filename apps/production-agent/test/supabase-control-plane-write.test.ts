import { OperationIdSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { SupabaseControlPlane } from '../src/index.js';
import { assignedSnapshotRows, claimRow } from './control-plane-fixtures.js';
import { FakeControlPlaneExecutor } from './fake-control-plane.js';

const operationId = OperationIdSchema.parse('81000000-0000-4000-8000-000000000001');

describe('SupabaseControlPlane writes', () => {
  it('claims and renews through the existing atomic RPC', async () => {
    const fake = new FakeControlPlaneExecutor();
    fake.succeed(claimRow());
    fake.succeed(claimRow());
    const controlPlane = new SupabaseControlPlane(fake.execute);
    const signal = new AbortController().signal;

    const initial = await controlPlane.claimOperation(operationId, 60, signal);
    const renewal = await controlPlane.claimOperation(operationId, 60, signal);

    expect(initial.status).toBe('claimed');
    expect(renewal.status).toBe('claimed');
    expect(fake.requests[0]).toMatchObject({
      name: 'production_claim_operation_v1',
      args: { p_operation_id: operationId, p_lease_seconds: 60 },
    });
  });

  it('maps duplicate claim conflicts without exposing server text', async () => {
    const fake = new FakeControlPlaneExecutor();
    fake.fail('P0001', 'OPERATION_CLAIM_CONFLICT secret database detail');
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const claim = controlPlane.claimOperation(operationId, 60, new AbortController().signal);

    await expect(claim).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(claim).rejects.not.toThrow('secret database detail');
  });

  it('maps PostgreSQL no-data errors without exposing server text', async () => {
    const fake = new FakeControlPlaneExecutor();
    fake.fail('P0002', 'private row lookup detail');
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const claim = controlPlane.claimOperation(operationId, 60, new AbortController().signal);

    await expect(claim).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(claim).rejects.not.toThrow('private row lookup detail');
  });

  it('rejects invalid operation IDs before transport execution', async () => {
    const fake = new FakeControlPlaneExecutor();
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const claim = Reflect.apply(controlPlane.claimOperation, controlPlane, [
      'invalid-operation-id',
      60,
      new AbortController().signal,
    ]);

    await expect(claim).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.requests).toEqual([]);
  });

  it('rejects leases outside the existing RPC semantics', async () => {
    const fake = new FakeControlPlaneExecutor();
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const claim = controlPlane.claimOperation(operationId, 14, new AbortController().signal);

    await expect(claim).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.requests).toEqual([]);
  });

  it('completes operations and reports bigint observations as canonical models', async () => {
    const fake = new FakeControlPlaneExecutor();
    const rows = assignedSnapshotRows();
    fake.succeed(claimRow('completed'));
    fake.succeed({ ...rows.observed, sequence: '42' });
    const controlPlane = new SupabaseControlPlane(fake.execute);
    const signal = new AbortController().signal;

    const completed = await controlPlane.completeOperation({
      operationId,
      status: 'completed',
      result: { summary: 'Applied', retryable: false },
    }, signal);
    const observed = await controlPlane.reportObservedState({
      outputId: rows.snapshot.output.id,
      sequence: 42,
      health: 'healthy',
      state: {},
    }, signal);

    expect(completed.status).toBe('completed');
    expect(observed.sequence).toBe(42);
    expect(fake.requests.map((request) => request.name)).toEqual([
      'production_complete_operation_v1',
      'production_report_observed_state_v1',
    ]);
  });

  it('loads only opaque assigned local secret references', async () => {
    const fake = new FakeControlPlaneExecutor();
    const rows = assignedSnapshotRows();
    fake.succeed({
      outputs: [{ id: rows.snapshot.output.id, secretRef: 'local://outputs/program' }],
      devices: [{
        id: rows.snapshot.desired.desired.profile.videoSourceDeviceId,
        secretRef: 'local://devices/camera',
      }],
    });
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const refs = await controlPlane.loadAssignedSecretRefs(
      rows.snapshot.output.eventId,
      new AbortController().signal,
    );

    expect(refs.outputs[0]?.secretRef).toBe('local://outputs/program');
    expect(refs.devices[0]?.secretRef).toBe('local://devices/camera');
    expect(fake.requests[0]).toMatchObject({ name: 'production_get_assigned_secret_refs_v1' });
  });

  it('omits valid null output secret references', async () => {
    const fake = new FakeControlPlaneExecutor();
    const rows = assignedSnapshotRows();
    fake.succeed({
      outputs: [
        { id: rows.snapshot.output.id, secretRef: null },
        { id: '70000000-0000-4000-8000-000000000099', secretRef: 'local://outputs/backup' },
      ],
      devices: [],
    });
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const refs = await controlPlane.loadAssignedSecretRefs(
      rows.snapshot.output.eventId,
      new AbortController().signal,
    );

    expect(refs.outputs).toEqual([
      { id: '70000000-0000-4000-8000-000000000099', secretRef: 'local://outputs/backup' },
    ]);
  });

  it('rejects invalid event IDs before transport execution', async () => {
    const fake = new FakeControlPlaneExecutor();
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const read = Reflect.apply(controlPlane.loadAssignedSecretRefs, controlPlane, [
      'invalid-event-id',
      new AbortController().signal,
    ]);

    await expect(read).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.requests).toEqual([]);
  });

  it('rejects non-local secret values without leaking them', async () => {
    const fake = new FakeControlPlaneExecutor();
    const rows = assignedSnapshotRows();
    fake.succeed({ outputs: [{ id: rows.snapshot.output.id, secretRef: 'https://secret' }], devices: [] });
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const read = controlPlane.loadAssignedSecretRefs(
      rows.snapshot.output.eventId,
      new AbortController().signal,
    );

    await expect(read).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(read).rejects.not.toThrow('https://secret');
  });
});
