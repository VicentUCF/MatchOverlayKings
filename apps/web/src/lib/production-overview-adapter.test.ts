import { describe, expect, it, vi } from 'vitest';
import {
  createProductionOverviewAdapter,
  type ProductionBackend,
  type ProductionTable,
} from './production-overview-adapter.js';
import {
  CLUB_ID,
  OUTPUT_ID,
  productionDataset,
  USER_ID,
} from './production-overview-test-fixtures.js';

function backendFor(role: 'operator' | 'viewer' = 'operator') {
  const dataset = productionDataset(role);
  const rpc = vi.fn(async (): Promise<unknown> => ({ data: dataset.production_desired_states[0], error: null }));
  const removeChannel = vi.fn(async () => 'ok');
  const subscribe = vi.fn((table: ProductionTable) => ({ table, remove: removeChannel }));
  const select = vi.fn(async (table: ProductionTable) => ({ data: dataset[table], error: null }));
  const backend: ProductionBackend = {
    currentUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    select,
    rpc,
    subscribe,
  };
  return { backend, dataset, removeChannel, rpc, select, subscribe };
}

describe('production overview adapter', () => {
  it('returns a viewer access object with no mutation API', async () => {
    const { backend, rpc } = backendFor('viewer');

    const result = await createProductionOverviewAdapter(backend).load();

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.access.kind).toBe('viewer');
    expect('reconcile' in result.access).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('loads production access when the Supabase user includes ordinary fields', async () => {
    const { backend, select } = backendFor();
    const backendWithSupabaseUser: ProductionBackend = {
      ...backend,
      currentUser: async () => ({
        data: {
          user: {
            id: USER_ID,
            email: 'operator@example.invalid',
            role: 'authenticated',
          },
        },
        error: null,
      }),
    };

    const result = await createProductionOverviewAdapter(backendWithSupabaseUser).load();

    expect(result.kind).toBe('success');
    expect(select).toHaveBeenCalledWith('production_principals', {
      column: 'auth_user_id',
      value: USER_ID,
    });
  });

  it('keeps unresolved production capability forbidden and non-mutating', async () => {
    const { backend, dataset, rpc } = backendFor('viewer');
    dataset.production_principal_roles = [];
    dataset.production_assignments = [];

    const result = await createProductionOverviewAdapter(backend).load();

    expect(result).toEqual({ kind: 'forbidden' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls only the desired-state RPC with current profile and version for operators', async () => {
    const { backend, dataset, rpc } = backendFor();
    const adapter = createProductionOverviewAdapter(backend, () => 'generated-command');
    const loaded = await adapter.load();
    if (loaded.kind !== 'success' || loaded.access.kind !== 'operator') throw new Error('operator fixture failed');
    const assignedCourt = loaded.access.snapshot.courts[0];
    if (!assignedCourt.assignment) throw new Error('assignment fixture failed');

    const result = await loaded.access.reconcile(assignedCourt.assignment, 'stopped');

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.acknowledgement).toBe('reconciliation_requested');
    expect(rpc).toHaveBeenCalledWith('production_set_desired_state_v1', {
      p_output_id: OUTPUT_ID,
      p_state: {
        lifecycle: 'stopped',
        profile: dataset.production_desired_states[0]?.state.profile,
      },
      p_expected_version: 3,
      p_command_id: 'generated-command',
      p_operation_kind: 'reconcile',
      p_operation_payload: {},
    });
  });

  it('maps version conflicts without treating them as success', async () => {
    const { backend, rpc } = backendFor();
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'VERSION_CONFLICT:4' } });
    const adapter = createProductionOverviewAdapter(backend, () => 'generated-command');
    const loaded = await adapter.load();
    if (loaded.kind !== 'success' || loaded.access.kind !== 'operator') throw new Error('operator fixture failed');
    const assignment = loaded.access.snapshot.courts[0].assignment;
    if (!assignment) throw new Error('assignment fixture failed');

    await expect(loaded.access.reconcile(assignment, 'running')).resolves.toEqual({
      kind: 'conflict',
      currentVersion: 4,
    });
  });

  it.each([
    [{ code: '42501', message: 'FORBIDDEN' }, 'forbidden'],
    [{ code: 'P0001', message: 'network unavailable' }, 'transport'],
  ] as const)('maps RPC error %s to %s', async (error, expectedKind) => {
    const { backend, rpc } = backendFor();
    rpc.mockResolvedValueOnce({ data: null, error });
    const loaded = await createProductionOverviewAdapter(backend).load();
    if (loaded.kind !== 'success' || loaded.access.kind !== 'operator') throw new Error('operator fixture failed');
    const assignment = loaded.access.snapshot.courts[0].assignment;
    if (!assignment) throw new Error('assignment fixture failed');

    const result = await loaded.access.reconcile(assignment, 'running');

    expect(result.kind).toBe(expectedKind);
  });

  it('maps a malformed successful RPC response', async () => {
    const { backend, rpc } = backendFor();
    rpc.mockResolvedValueOnce({ data: { version: 4 }, error: null });
    const loaded = await createProductionOverviewAdapter(backend).load();
    if (loaded.kind !== 'success' || loaded.access.kind !== 'operator') throw new Error('operator fixture failed');
    const assignment = loaded.access.snapshot.courts[0].assignment;
    if (!assignment) throw new Error('assignment fixture failed');

    const result = await loaded.access.reconcile(assignment, 'running');

    expect(result).toEqual({ kind: 'malformed' });
  });

  it('subscribes only to production state tables and removes every channel', async () => {
    const { backend, removeChannel, subscribe } = backendFor();
    const adapter = createProductionOverviewAdapter(backend);
    const loaded = await adapter.load();
    if (loaded.kind !== 'success') throw new Error('authorized fixture failed');
    const cleanup = adapter.subscribe(loaded.access, () => undefined);

    cleanup();

    expect(subscribe.mock.calls.map(([table]) => table)).toEqual([
      'production_desired_states',
      'production_observed_states',
      'production_operations',
      'production_operation_claims',
    ]);
    expect(removeChannel).toHaveBeenCalledTimes(4);
  });

  it('loads operation claims with the resolved club filter', async () => {
    const { backend, select } = backendFor();

    const result = await createProductionOverviewAdapter(backend).load();

    expect(result.kind).toBe('success');
    expect(select).toHaveBeenCalledWith('production_operation_claims', {
      column: 'club_id',
      value: CLUB_ID,
    });
  });
});
