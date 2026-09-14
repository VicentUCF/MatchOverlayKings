import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createProductionOverviewAdapter } from '../lib/production-overview-adapter.js';
import type {
  ProductionLoadResult,
  ProductionOverviewAccess,
  ProductionOverviewAdapter,
} from '../lib/production-overview-types.js';

const DEFAULT_PRODUCTION_OVERVIEW_ADAPTER = createProductionOverviewAdapter();

export type ProductionOverviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly access: ProductionOverviewAccess; readonly refreshing: false }
  | {
      readonly kind: 'refreshing';
      readonly access: ProductionOverviewAccess;
      readonly refreshing: true;
    }
  | {
      readonly kind: 'stale';
      readonly access: ProductionOverviewAccess;
      readonly error: { readonly kind: 'malformed' | 'transport' };
    }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error'; readonly error: { readonly kind: 'malformed' | 'transport' } };

export type ProductionOverviewStore = {
  readonly getSnapshot: () => ProductionOverviewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  readonly start: () => () => void;
};

export type UseProductionOverviewResult = {
  readonly state: ProductionOverviewState;
  readonly refresh: () => Promise<void>;
};

export function createProductionOverviewStore(adapter: ProductionOverviewAdapter): ProductionOverviewStore {
  let state: ProductionOverviewState = { kind: 'loading' };
  const listeners = new Set<() => void>();
  let realtimeCleanup: (() => void) | null = null;
  let started = false;
  let lastAccess: ProductionOverviewAccess | null = null;

  const publish = (next: ProductionOverviewState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const refresh = async () => {
    if (lastAccess !== null) publish({
      kind: 'refreshing',
      access: lastAccess,
      refreshing: true,
    });
    const result = await adapter.load();
    publish(loadState(result));
  };

  return Object.freeze({
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    start: () => {
      started = true;
      void refresh();
      return () => {
        started = false;
        realtimeCleanup?.();
        realtimeCleanup = null;
      };
    },
  });

  function installRealtime(access: ProductionOverviewAccess): void {
    realtimeCleanup?.();
    realtimeCleanup = started
      ? adapter.subscribe(access, () => void refresh())
      : null;
  }

  function loadState(
    result: ProductionLoadResult,
  ): ProductionOverviewState {
    switch (result.kind) {
      case 'success':
        lastAccess = result.access;
        installRealtime(result.access);
        return { kind: 'ready', access: result.access, refreshing: false };
      case 'forbidden':
        lastAccess = null;
        realtimeCleanup?.();
        realtimeCleanup = null;
        return { kind: 'forbidden' };
      case 'malformed':
      case 'transport':
        return lastAccess === null
          ? { kind: 'error', error: { kind: result.kind } }
          : {
              kind: 'stale',
              access: lastAccess,
              error: { kind: result.kind },
            };
      default:
        return assertNever(result);
    }
  }
}

export function useProductionOverview(
  adapter: ProductionOverviewAdapter = DEFAULT_PRODUCTION_OVERVIEW_ADAPTER,
): UseProductionOverviewResult {
  const store = useMemo(() => createProductionOverviewStore(adapter), [adapter]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => store.start(), [store]);

  return useMemo(() => ({ state, refresh: store.refresh }), [state, store]);
}

function assertNever(value: never): never {
  void value;
  throw new TypeError('Unexpected production load result');
}
