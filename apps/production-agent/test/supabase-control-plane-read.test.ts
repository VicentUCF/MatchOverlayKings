import { describe, expect, it } from 'vitest';
import {
  ControlPlaneAdapterError,
  SupabaseControlPlane,
} from '../src/index.js';
import { assignedSnapshotRows, operationRow } from './control-plane-fixtures.js';
import { FakeControlPlaneExecutor } from './fake-control-plane.js';

describe('SupabaseControlPlane reads', () => {
  it('assembles assigned snapshots from strict column-limited rows', async () => {
    const fake = new FakeControlPlaneExecutor();
    const rows = assignedSnapshotRows();
    fake.succeed([{ output: rows.output, desired: rows.desired, observed: rows.observed }]);
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const snapshots = await controlPlane.loadAssignedOutputSnapshots(new AbortController().signal);

    expect(snapshots).toEqual([rows.snapshot]);
    expect(fake.requests).toEqual([{
      kind: 'rpc',
      name: 'production_get_assigned_output_snapshots_v1',
      args: {},
    }]);
    expect(JSON.stringify(fake.requests)).not.toContain('secret_ref');
  });

  it('lists bounded claimable operations through the discovery RPC', async () => {
    const fake = new FakeControlPlaneExecutor();
    fake.succeed([operationRow()]);
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const operations = await controlPlane.listClaimableOperations(25, new AbortController().signal);

    expect(operations[0]).toMatchObject({ commandId: 'agent-operation-1', kind: 'reconcile' });
    expect(fake.requests).toEqual([{
      kind: 'rpc',
      name: 'production_list_claimable_operations_v1',
      args: { p_limit: 25 },
    }]);
  });

  it('rejects malformed snapshot rows with a bounded adapter error', async () => {
    const fake = new FakeControlPlaneExecutor();
    const rows = assignedSnapshotRows();
    fake.succeed([{
      output: { ...rows.output, secret_ref: 'local://must-not-escape' },
      desired: rows.desired,
      observed: rows.observed,
    }]);
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const read = controlPlane.loadAssignedOutputSnapshots(new AbortController().signal);

    await expect(read).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(read).rejects.not.toThrow('local://must-not-escape');
  });

  it('rejects an already-aborted request before transport execution', async () => {
    const fake = new FakeControlPlaneExecutor();
    const controller = new AbortController();
    controller.abort();
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const read = controlPlane.listClaimableOperations(1, controller.signal);

    await expect(read).rejects.toEqual(new ControlPlaneAdapterError('ABORTED'));
    expect(fake.requests).toEqual([]);
  });

  it('rejects discovery limits outside the adapter bound', async () => {
    const fake = new FakeControlPlaneExecutor();
    const controlPlane = new SupabaseControlPlane(fake.execute);

    const read = controlPlane.listClaimableOperations(101, new AbortController().signal);

    await expect(read).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.requests).toEqual([]);
  });

});
