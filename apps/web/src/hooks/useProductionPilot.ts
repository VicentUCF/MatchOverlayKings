import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PilotCourtSlug, PilotReadiness, PilotSession, PreparePilotSessionInput } from '@kpl/production-contracts';
import { createProductionPilotAdapter, type ProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

type ReadyPilotState = {
  readonly kind: 'ready';
  readonly readiness: PilotReadiness;
  readonly sessions: readonly PilotSession[];
  readonly refreshing: boolean;
  readonly pendingCourts: readonly PilotCourtSlug[];
  readonly courtErrors: Readonly<Partial<Record<PilotCourtSlug, string>>>;
  readonly error: string | null;
};

type PilotState =
  | { readonly kind: 'loading' }
  | ReadyPilotState
  | { readonly kind: 'error'; readonly message: string };

const defaultAdapter = createProductionPilotAdapter();

export function useProductionPilot(adapter: ProductionPilotAdapter = defaultAdapter) {
  const [state, setState] = useState<PilotState>({ kind: 'loading' });
  const refreshSequence = useRef(0);

  const refresh = useCallback(async (quiet = false) => {
    const requestId = ++refreshSequence.current;
    if (!quiet) setState((current) => current.kind === 'ready' ? { ...current, refreshing: true, error: null } : current);
    const [readiness, sessions] = await Promise.all([adapter.readiness(), adapter.sessions()]);
    if (requestId !== refreshSequence.current) return;
    const failure = readiness.kind === 'error' ? readiness.message : sessions.kind === 'error' ? sessions.message : null;
    if (failure !== null) {
      setState((current) => current.kind === 'ready'
        ? { ...current, refreshing: false, error: failure }
        : { kind: 'error', message: failure });
      return;
    }
    if (readiness.kind !== 'success' || sessions.kind !== 'success') return;
    setState((current): PilotState => current.kind === 'ready'
      ? { ...current, readiness: readiness.value, sessions: sessions.value, refreshing: false, error: null }
      : {
        kind: 'ready', readiness: readiness.value, sessions: sessions.value, refreshing: false,
        pendingCourts: [], courtErrors: {}, error: null,
      });
  }, [adapter]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActiveSessions = state.kind === 'ready'
    && state.sessions.some(({ status }) => ['starting', 'live', 'stopping'].includes(status));
  useEffect(() => {
    if (!hasActiveSessions) return undefined;
    const interval = window.setInterval(() => { void refresh(true); }, 2_000);
    return () => window.clearInterval(interval);
  }, [hasActiveSessions, refresh]);

  const mutate = useCallback(async (
    courtSlug: PilotCourtSlug,
    operation: () => Promise<{ readonly kind: 'success'; readonly value: PilotSession } | { readonly kind: 'error'; readonly message: string }>,
  ) => {
    setState((current) => current.kind === 'ready' ? {
      ...current,
      pendingCourts: addCourt(current.pendingCourts, courtSlug),
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
    const result = await operation();
    if (result.kind === 'error') {
      setState((current) => current.kind === 'ready' ? {
        ...current,
        pendingCourts: removeCourt(current.pendingCourts, courtSlug),
        courtErrors: { ...current.courtErrors, [courtSlug]: result.message },
      } : current);
      return;
    }
    await refresh(true);
    setState((current) => current.kind === 'ready' ? {
      ...current,
      pendingCourts: removeCourt(current.pendingCourts, courtSlug),
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
  }, [refresh]);

  return useMemo(() => ({
    state,
    refresh: () => refresh(false),
    prepare: (input: PreparePilotSessionInput) => mutate(input.courtSlug, () => adapter.prepare(input)),
    start: (session: PilotSession) => mutate(session.courtSlug, () => adapter.start(session.id)),
    stop: (session: PilotSession) => mutate(session.courtSlug, () => adapter.stop(session.id)),
  }), [adapter, mutate, refresh, state]);
}

function addCourt(courts: readonly PilotCourtSlug[], court: PilotCourtSlug): readonly PilotCourtSlug[] {
  return courts.includes(court) ? courts : [...courts, court];
}

function removeCourt(courts: readonly PilotCourtSlug[], court: PilotCourtSlug): readonly PilotCourtSlug[] {
  return courts.filter((candidate) => candidate !== court);
}
