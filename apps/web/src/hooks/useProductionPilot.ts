import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Team } from '@kpl/shared';
import type {
  PilotConfiguration,
  PilotCourtSlug,
  PilotMobileCameraLink,
  PilotMobileCameraSession,
  PilotReadiness,
  PilotSession,
  PilotPreflightCheckId,
  PreparePilotSessionInput,
  UpdatePilotMobileCameraDesiredInput,
} from '@kpl/production-contracts';
import { createProductionPilotAdapter, type ProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

export type ReadyPilotState = {
  readonly kind: 'ready';
  readonly confirmedAt?: number;
  readonly readiness: PilotReadiness;
  readonly configurations: readonly PilotConfiguration[];
  readonly teams: readonly Team[];
  readonly sessions: readonly PilotSession[];
  readonly mobileCameras: readonly PilotMobileCameraSession[];
  readonly mobileConnectUrls: Readonly<Record<string, string>>;
  readonly refreshing: boolean;
  readonly pendingCourts: readonly PilotCourtSlug[];
  readonly courtErrors: Readonly<Partial<Record<PilotCourtSlug, string>>>;
  readonly error: string | null;
};

export type PilotState =
  | { readonly kind: 'loading' }
  | ReadyPilotState
  | { readonly kind: 'error'; readonly message: string };

export type ProductionPilotController = ReturnType<typeof useProductionPilot>;

const defaultAdapter = createProductionPilotAdapter();

export function useProductionPilot(adapter: ProductionPilotAdapter = defaultAdapter) {
  const [state, setState] = useState<PilotState>({ kind: 'loading' });
  const refreshSequence = useRef(0);
  const runtimeRefreshSequence = useRef(0);
  const runtimeRefreshActive = useRef(false);
  const runtimeRefreshQueued = useRef(false);
  const mutationCounts = useRef(new Map<PilotCourtSlug, number>());

  const refresh = useCallback(async (quiet = false) => {
    runtimeRefreshSequence.current += 1;
    const requestId = ++refreshSequence.current;
    if (!quiet) setState((current) => current.kind === 'ready' ? { ...current, refreshing: true, error: null } : current);
    const [runtime, configurations, teams] = await Promise.all([
      adapter.runtimeSnapshot(), adapter.configurations(), adapter.teams(),
    ]);
    if (requestId !== refreshSequence.current) return;
    const failure = runtime.kind === 'error'
      ? runtime.message
      : configurations.kind === 'error' ? configurations.message
        : teams.kind === 'error' ? teams.message : null;
    if (failure !== null) {
      setState((current) => current.kind === 'ready'
        ? { ...current, refreshing: false, error: failure }
        : { kind: 'error', message: failure });
      return;
    }
    if (runtime.kind !== 'success' || configurations.kind !== 'success' || teams.kind !== 'success') return;
    setState((current): PilotState => current.kind === 'ready'
      ? {
        ...current, confirmedAt: Date.now(), readiness: runtime.value.readiness, sessions: runtime.value.sessions,
        configurations: configurations.value, teams: teams.value, mobileCameras: runtime.value.mobileCameras,
        mobileConnectUrls: activeMobileLinks(current.mobileConnectUrls, runtime.value.mobileCameras),
        refreshing: false, error: null,
      }
      : {
        kind: 'ready', confirmedAt: Date.now(), readiness: runtime.value.readiness, sessions: runtime.value.sessions,
        configurations: configurations.value, teams: teams.value, refreshing: false,
        mobileCameras: runtime.value.mobileCameras, mobileConnectUrls: {},
        pendingCourts: [], courtErrors: {}, error: null,
      });
  }, [adapter]);

  const refreshRuntime = useCallback(async () => {
    const requestId = ++runtimeRefreshSequence.current;
    const runtime = await adapter.runtimeSnapshot();
    if (requestId !== runtimeRefreshSequence.current) return;
    if (runtime.kind === 'error') {
      setState((current) => current.kind === 'ready'
        ? { ...current, refreshing: false, error: runtime.message }
        : current);
      return;
    }
    setState((current): PilotState => current.kind === 'ready'
      ? {
        ...current, confirmedAt: Date.now(), readiness: runtime.value.readiness, sessions: runtime.value.sessions,
        mobileCameras: runtime.value.mobileCameras,
        mobileConnectUrls: activeMobileLinks(current.mobileConnectUrls, runtime.value.mobileCameras),
        refreshing: false, error: null,
      }
      : current);
  }, [adapter]);

  const requestRuntimeRefresh = useCallback(() => {
    if (runtimeRefreshActive.current) {
      runtimeRefreshQueued.current = true;
      return;
    }
    runtimeRefreshActive.current = true;
    void (async () => {
      try {
        do {
          runtimeRefreshQueued.current = false;
          await refreshRuntime();
        } while (runtimeRefreshQueued.current);
      } finally {
        runtimeRefreshActive.current = false;
      }
    })();
  }, [refreshRuntime]);

  useEffect(() => { void refresh(); }, [refresh]);
  const needsLivePolling = state.kind === 'ready'
    && (state.pendingCourts.length > 0 || state.sessions.some(({ status, preflight }) => ['preparing', 'starting', 'live', 'reconnecting', 'stopping'].includes(status)
      || (status === 'prepared' && preflight !== null && preflight !== undefined && ['running', 'ready', 'warning'].includes(preflight.status)))
      || state.mobileCameras.some(({ state }) => state !== 'revoked'));
  useEffect(() => {
    let timer: number | undefined;
    let requiresFullRefresh = false;
    const unsubscribe = adapter.subscribeToEvents(({ scope }) => {
      if (scope === 'recordings') return;
      requiresFullRefresh ||= scope === 'configurations';
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (requiresFullRefresh) {
          requiresFullRefresh = false;
          void refresh(true);
        } else requestRuntimeRefresh();
      }, 50);
    });
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [adapter, refresh, requestRuntimeRefresh]);

  useEffect(() => {
    if (state.kind !== 'ready' || !needsLivePolling) return undefined;
    const timer = window.setInterval(requestRuntimeRefresh, 60_000);
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') requestRuntimeRefresh();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [needsLivePolling, requestRuntimeRefresh, state.kind]);

  const mutate = useCallback(async (
    courtSlug: PilotCourtSlug,
    operation: () => Promise<{ readonly kind: 'success'; readonly value: PilotSession } | { readonly kind: 'error'; readonly message: string }>,
  ) => {
    mutationCounts.current.set(courtSlug, (mutationCounts.current.get(courtSlug) ?? 0) + 1);
    const settle = () => {
      const remaining = (mutationCounts.current.get(courtSlug) ?? 1) - 1;
      if (remaining === 0) mutationCounts.current.delete(courtSlug);
      else mutationCounts.current.set(courtSlug, remaining);
      return remaining === 0;
    };
    setState((current) => current.kind === 'ready' ? {
      ...current,
      pendingCourts: addCourt(current.pendingCourts, courtSlug),
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
    const result = await operation();
    if (result.kind === 'error') {
      await refresh(true);
      const finished = settle();
      setState((current) => current.kind === 'ready' ? {
        ...current,
        pendingCourts: finished ? removeCourt(current.pendingCourts, courtSlug) : current.pendingCourts,
        courtErrors: { ...current.courtErrors, [courtSlug]: result.message },
      } : current);
      return;
    }
    await refresh(true);
    const finished = settle();
    setState((current) => current.kind === 'ready' ? {
      ...current,
      pendingCourts: finished ? removeCourt(current.pendingCourts, courtSlug) : current.pendingCourts,
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
  }, [refresh]);

  const configure = useCallback(async (input: PreparePilotSessionInput) => {
    const courtSlug = input.courtSlug;
    setState((current) => current.kind === 'ready' ? {
      ...current,
      pendingCourts: addCourt(current.pendingCourts, courtSlug),
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
    const result = await adapter.configure(input);
    if (result.kind === 'error') {
      setState((current) => current.kind === 'ready' ? {
        ...current,
        pendingCourts: removeCourt(current.pendingCourts, courtSlug),
        courtErrors: { ...current.courtErrors, [courtSlug]: result.message },
      } : current);
      return false;
    }
    setState((current) => current.kind === 'ready' ? {
      ...current,
      configurations: replaceConfiguration(current.configurations, result.value),
      pendingCourts: removeCourt(current.pendingCourts, courtSlug),
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
    return true;
  }, [adapter]);

  const createMobileCamera = useCallback(async (courtSlug: PilotCourtSlug): Promise<PilotMobileCameraLink | null> => {
    setState((current) => current.kind === 'ready' ? {
      ...current, pendingCourts: addCourt(current.pendingCourts, courtSlug),
      courtErrors: { ...current.courtErrors, [courtSlug]: undefined },
    } : current);
    const result = await adapter.createMobileCamera(courtSlug);
    refreshSequence.current += 1;
    if (result.kind === 'error') {
      setState((current) => current.kind === 'ready' ? {
        ...current, pendingCourts: removeCourt(current.pendingCourts, courtSlug),
        courtErrors: { ...current.courtErrors, [courtSlug]: result.message },
      } : current);
      return null;
    }
    setState((current) => current.kind === 'ready' ? {
      ...current,
      mobileCameras: replaceMobileCamera(current.mobileCameras, result.value.session),
      mobileConnectUrls: activeMobileLinks(
        { ...current.mobileConnectUrls, [result.value.session.id]: result.value.connectUrl },
        replaceMobileCamera(current.mobileCameras, result.value.session),
      ),
      refreshing: false,
      pendingCourts: removeCourt(current.pendingCourts, courtSlug),
    } : current);
    return result.value;
  }, [adapter]);

  const updateMobileCamera = useCallback(async (
    id: string,
    input: UpdatePilotMobileCameraDesiredInput,
  ): Promise<boolean> => {
    const result = await adapter.updateMobileCamera(id, input);
    refreshSequence.current += 1;
    if (result.kind === 'error') {
      setState((current) => current.kind === 'ready' ? { ...current, error: result.message } : current);
      return false;
    }
    setState((current) => current.kind === 'ready'
      ? { ...current, mobileCameras: replaceMobileCamera(current.mobileCameras, result.value), refreshing: false, error: null }
      : current);
    return true;
  }, [adapter]);

  const revokeMobileCamera = useCallback(async (id: string): Promise<boolean> => {
    const result = await adapter.revokeMobileCamera(id);
    refreshSequence.current += 1;
    if (result.kind === 'error') {
      setState((current) => current.kind === 'ready' ? { ...current, error: result.message } : current);
      return false;
    }
    setState((current) => current.kind === 'ready'
      ? {
        ...current, mobileCameras: replaceMobileCamera(current.mobileCameras, result.value),
        mobileConnectUrls: Object.fromEntries(Object.entries(current.mobileConnectUrls).filter(([key]) => key !== id)),
        refreshing: false, error: null,
      }
      : current);
    return true;
  }, [adapter]);

  return useMemo(() => ({
    state,
    localAdminUrl: adapter.localAdminUrl,
    recordingDirectories: adapter.recordingDirectories,
    refresh: () => refresh(false),
    configure,
    createMobileCamera,
    updateMobileCamera,
    revokeMobileCamera,
    prepare: (input: PreparePilotSessionInput) => mutate(input.courtSlug, () => adapter.prepare(input)),
    start: (session: PilotSession) => mutate(session.courtSlug, () => adapter.start(session.id)),
    preflight: (session: PilotSession, check?: PilotPreflightCheckId) => mutate(session.courtSlug, () => adapter.preflight(session.id, check)),
    cancelPreflight: (session: PilotSession) => mutate(session.courtSlug, () => adapter.cancelPreflight(session.id)),
    preview: adapter.preview,
    recover: (session: PilotSession) => mutate(session.courtSlug, () => adapter.recover(session.id)),
    stop: (session: PilotSession) => mutate(session.courtSlug, () => adapter.stop(session.id)),
  }), [adapter, configure, createMobileCamera, mutate, refresh, revokeMobileCamera, state, updateMobileCamera]);
}

function replaceConfiguration(
  configurations: readonly PilotConfiguration[],
  configuration: PilotConfiguration,
): readonly PilotConfiguration[] {
  return [...configurations.filter(({ courtSlug }) => courtSlug !== configuration.courtSlug), configuration];
}

function replaceMobileCamera(sessions: readonly PilotMobileCameraSession[], session: PilotMobileCameraSession) {
  return [...sessions.filter(({ courtSlug }) => courtSlug !== session.courtSlug), session];
}

function activeMobileLinks(links: Readonly<Record<string, string>>, sessions: readonly PilotMobileCameraSession[]) {
  const activeIds = new Set(sessions.filter(({ state }) => state !== 'revoked').map(({ id }) => id));
  return Object.fromEntries(Object.entries(links).filter(([id]) => activeIds.has(id)));
}

function addCourt(courts: readonly PilotCourtSlug[], court: PilotCourtSlug): readonly PilotCourtSlug[] {
  return courts.includes(court) ? courts : [...courts, court];
}

function removeCourt(courts: readonly PilotCourtSlug[], court: PilotCourtSlug): readonly PilotCourtSlug[] {
  return courts.filter((candidate) => candidate !== court);
}
