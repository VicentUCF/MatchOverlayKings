import { describe, expect, it, vi } from 'vitest';
import { createProductionOverviewAdapter } from '../lib/production-overview-adapter.js';
import { productionDataset, USER_ID } from '../lib/production-overview-test-fixtures.js';
import { createProductionOverviewStore } from './useProductionOverview.js';

describe('production overview store', () => {
  it('loads immediately, subscribes after authorization, and cleans up all Realtime channels', async () => {
    const dataset = productionDataset();
    const remove = vi.fn(async () => 'ok');
    const adapter = createProductionOverviewAdapter({
      currentUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
      select: async (table) => ({ data: dataset[table], error: null }),
      rpc: async () => ({ data: null, error: null }),
      subscribe: (table) => ({ table, remove }),
    });
    const store = createProductionOverviewStore(adapter);

    const cleanup = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().kind).toBe('ready'));
    cleanup();

    expect(remove).toHaveBeenCalledTimes(11);
  });

  it('preserves the complete operator access while refreshing and after refresh failure', async () => {
    const dataset = productionDataset();
    let transportFails = false;
    const adapter = createProductionOverviewAdapter({
      currentUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
      select: async (table) => transportFails
        ? { data: null, error: { code: 'NETWORK', message: 'offline' } }
        : { data: dataset[table], error: null },
      rpc: async () => ({ data: null, error: null }),
      subscribe: (table) => ({ table, remove: async () => 'ok' }),
    });
    const store = createProductionOverviewStore(adapter);
    await store.refresh();
    const lastGood = store.getSnapshot();
    transportFails = true;

    const refresh = store.refresh();
    const refreshing = store.getSnapshot();

    expect(lastGood.kind).toBe('ready');
    expect(refreshing.kind).toBe('refreshing');
    if (lastGood.kind !== 'ready' || refreshing.kind !== 'refreshing') return;
    expect(refreshing.access).toBe(lastGood.access);
    expect(lastGood.access.kind).toBe('operator');
    expect(refreshing.access.kind).toBe('operator');
    if (lastGood.access.kind !== 'operator' || refreshing.access.kind !== 'operator') return;
    expect(refreshing.access.reconcile).toBe(lastGood.access.reconcile);

    await refresh;

    const stale = store.getSnapshot();
    expect(stale.kind).toBe('stale');
    if (stale.kind !== 'stale') return;
    expect(stale.access).toBe(lastGood.access);
    expect(stale.access.kind).toBe('operator');
    if (stale.access.kind !== 'operator') return;
    expect(stale.access.reconcile).toBe(lastGood.access.reconcile);
    expect(stale.error).toEqual({ kind: 'transport' });
  });

  it('clears access and subscriptions when forbidden, then replaces access after authorization returns', async () => {
    const dataset = productionDataset();
    let authorized = true;
    const remove = vi.fn(async () => 'ok');
    const adapter = createProductionOverviewAdapter({
      currentUser: async () => ({ data: { user: authorized ? { id: USER_ID } : null }, error: null }),
      select: async (table) => ({ data: dataset[table], error: null }),
      rpc: async () => ({ data: null, error: null }),
      subscribe: (table) => ({ table, remove }),
    });
    const store = createProductionOverviewStore(adapter);
    const cleanup = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().kind).toBe('ready'));
    const first = store.getSnapshot();
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;

    authorized = false;
    await store.refresh();

    expect(store.getSnapshot()).toEqual({ kind: 'forbidden' });
    expect(remove).toHaveBeenCalledTimes(11);

    authorized = true;
    const reload = store.refresh();
    expect(store.getSnapshot()).toEqual({ kind: 'forbidden' });
    await reload;

    const next = store.getSnapshot();
    expect(next.kind).toBe('ready');
    if (next.kind !== 'ready') return;
    expect(next.access).not.toBe(first.access);
    cleanup();
  });
});
