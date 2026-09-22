import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClientRole,
  ClientToServerEvents,
  ManualScorePatch,
  MatchCardId,
  MatchMetaPatch,
  MatchState,
  NewMatchSetup,
  OverlayDataSceneKind,
  OverlayDataSceneTarget,
  OverlaySettingsPatch,
  Side,
  SponsorTickerPatch,
  Team,
} from '@kpl/shared';
import { createCommandId } from '../command-id.js';
import {
  type EventSummary,
  fetchEventSummaries,
  fetchMatchState,
  fetchTeams,
  subscribeToMatchState,
} from '../lib/kpl-data.js';
import { supabase } from '../lib/supabase.js';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
type CommandEventName = Exclude<keyof ClientToServerEvents, 'join:event'>;
type RpcEventName = Exclude<CommandEventName, never>;

export interface MatchSocketState {
  connectionState: ConnectionState;
  confirmedAt: number | null;
  state: MatchState | null;
  teams: Team[];
  events: EventSummary[];
  error: string | null;
  pending: boolean;
  addPoint: (side: Side) => Promise<boolean>;
  undo: () => Promise<boolean>;
  resetMatch: () => Promise<boolean>;
  manualPatch: (patch: ManualScorePatch) => Promise<boolean>;
  updateMeta: (patch: MatchMetaPatch) => Promise<boolean>;
  newMatch: (setup: NewMatchSetup) => Promise<boolean>;
  setStatus: (status: MatchState['status']) => Promise<boolean>;
  updateOverlaySettings: (patch: OverlaySettingsPatch) => Promise<boolean>;
  useMatchCard: (side: Side, cardId: MatchCardId, cardName: string) => Promise<boolean>;
  triggerDataScene: (kind: OverlayDataSceneKind, target: OverlayDataSceneTarget) => Promise<boolean>;
  updateSponsorTicker: (patch: SponsorTickerPatch) => Promise<boolean>;
  triggerSponsorFullscreen: (sponsorIds: string[] | null, durationSeconds?: number) => Promise<boolean>;
  refreshEvents: () => Promise<void>;
}

export function useMatchSocket(eventId: string, role: ClientRole, token: string): MatchSocketState {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null);
  const [state, setState] = useState<MatchState | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const stateRef = useRef<MatchState | null>(null);
  const controlToken = role === 'control' || role === 'overlay' ? token : '';
  const postproductionProjectId = postproductionProjectIdFromControlId(eventId);
  const loadState = useCallback(async () => {
    if (postproductionProjectId) {
      const snapshot = await fetchPostproductionControlSnapshot(postproductionProjectId, controlToken);
      setTeams(snapshot.teams);
      return snapshot.state;
    }
    if (!controlToken) return fetchMatchState(eventId, role === 'viewer');
    const { data, error } = await supabase.rpc('visual_control_command', {
      p_court_slug: eventId, p_token: controlToken, p_action: 'state',
    });
    if (error) throw new Error(error.message);
    return data as MatchState | null;
  }, [controlToken, eventId, postproductionProjectId, role]);

  const acceptState = useCallback((nextState: MatchState | null) => {
    const current = stateRef.current;
    // A delayed poll must not roll back a newer realtime or command result.
    if (nextState && current?.id === nextState.id && nextState.version < current.version) return false;
    stateRef.current = nextState;
    setState(nextState);
    setConfirmedAt(Date.now());
    return true;
  }, []);

  const refreshEvents = useCallback(async () => {
    if (postproductionProjectId) { setEvents([]); return; }
    const nextEvents = controlToken ? [] : await fetchEventSummaries({ liveOnly: role !== 'control' });
    setEvents(nextEvents);
  }, [controlToken, postproductionProjectId, role]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const [teamsPayload, eventsPayload, statePayload] = await Promise.all([
          postproductionProjectId ? Promise.resolve([]) : fetchTeams(),
          controlToken ? Promise.resolve([]) : fetchEventSummaries({ liveOnly: role !== 'control' }),
          loadState(),
        ]);

        if (!cancelled) {
          if (!postproductionProjectId) setTeams(teamsPayload);
          setEvents(eventsPayload);
          acceptState(statePayload);
          setConnectionState('connected');
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(errorMessage(loadError));
          setConnectionState('error');
        }
      }
    }

    void loadInitialData();

    return () => {
      cancelled = true;
    };
  }, [acceptState, controlToken, eventId, loadState, postproductionProjectId, role]);

  useEffect(() => {
    if (controlToken || postproductionProjectId) return;
    setConnectionState('connecting');
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = subscribeToMatchState(eventId, (nextState) => {
        if (!acceptState(nextState)) return;
        setConnectionState('connected');
        if (role !== 'control') setError(null);

        if (role !== 'control') {
          void fetchEventSummaries({ liveOnly: true }).then(setEvents).catch(() => undefined);
        }
      }, role === 'viewer');
    } catch (subscribeError) {
      setError(errorMessage(subscribeError));
      setConnectionState('error');
    }

    return () => {
      unsubscribe?.();
    };
  }, [acceptState, controlToken, eventId, postproductionProjectId, role]);

  useEffect(() => {
    if (role === 'control' && !controlToken) {
      return undefined;
    }

    let cancelled = false;
    const refreshPublicState = async () => {
      try {
        const nextState = await loadState();

        if (cancelled) {
          return;
        }

        if (!acceptState(nextState)) return;
        setConnectionState('connected');
        if (role !== 'control') setError(null);
      } catch (refreshError) {
        if (!cancelled) {
          setError(errorMessage(refreshError));
          setConnectionState('error');
        }
      }
    };
    const intervalId = window.setInterval(() => {
      void refreshPublicState();
    }, controlToken ? 500 : 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [acceptState, controlToken, loadState, role]);

  const send = useCallback(
    async <TEvent extends RpcEventName>(
      event: TEvent,
      payload: Omit<Parameters<ClientToServerEvents[TEvent]>[0], 'eventId' | 'expectedVersion' | 'commandId'>,
    ) => {
      const current = stateRef.current;

      if (!current) {
        setError('Marcador no cargado.');
        return false;
      }

      setPending(true);
      setError(null);

      try {
        const commandPayload = {
          ...payload,
          eventId,
          expectedVersion: current.version,
          commandId: createCommandId(),
        };
        if (postproductionProjectId) {
          const command = toPostproductionCommand(event, commandPayload);
          const response = await fetch(`/api/postproduction-control/${encodeURIComponent(postproductionProjectId)}/command`, {
            method: 'POST',
            headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
            body: JSON.stringify(command),
          });
          const responsePayload = await response.json() as unknown;
          if (!response.ok) throw new Error(controlResponseError(responsePayload));
          const snapshot = controlSnapshot(responsePayload);
          setTeams(snapshot.teams);
          acceptState(snapshot.state);
          return true;
        }
        const { rpcName, params } = toRpcCall(event, commandPayload);
        const { data, error: rpcError } = await (controlToken
          ? supabase.rpc('visual_control_command', { p_court_slug: eventId, p_token: controlToken, p_action: rpcName, p_params: params })
          : supabase.rpc(rpcName, params));

        if (rpcError) {
          setError(rpcError.message);
          return false;
        }

        const nextState = data as MatchState;
        acceptState(nextState);
        await refreshEvents();
        return true;
      } catch (sendError) {
        setError(errorMessage(sendError));
        return false;
      } finally {
        setPending(false);
      }
    },
    [acceptState, controlToken, eventId, postproductionProjectId, refreshEvents],
  );

  return useMemo(
    () => ({
      connectionState,
      confirmedAt,
      state,
      teams,
      events,
      error,
      pending,
      addPoint: (side: Side) => send('score:addPoint', { side }),
      undo: () => send('score:undo', {}),
      resetMatch: () => send('score:resetMatch', {}),
      manualPatch: (patch: ManualScorePatch) => send('score:manualPatch', { patch }),
      updateMeta: (patch: MatchMetaPatch) => send('match:updateMeta', { patch }),
      newMatch: (setup: NewMatchSetup) => send('match:newMatch', { setup }),
      setStatus: (status: MatchState['status']) => send('match:setStatus', { status }),
      updateOverlaySettings: (patch: OverlaySettingsPatch) => send('overlay:updateSettings', { patch }),
      useMatchCard: (side: Side, cardId: MatchCardId, cardName: string) => send('match:useCard', { side, cardId, cardName }),
      triggerDataScene: (kind: OverlayDataSceneKind, target: OverlayDataSceneTarget) =>
        send('overlay:triggerDataScene', { kind, target }),
      updateSponsorTicker: (patch: SponsorTickerPatch) => send('overlay:updateSponsorTicker', { patch }),
      triggerSponsorFullscreen: (sponsorIds: string[] | null, durationSeconds?: number) =>
        send('overlay:triggerSponsorFullscreen', {
          sponsorIds,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        }),
      refreshEvents,
    }),
    [connectionState, confirmedAt, error, events, pending, refreshEvents, send, state, teams],
  );
}

function postproductionProjectIdFromControlId(eventId: string): string | null {
  const match = /^postproduction-([a-f0-9-]{36})$/i.exec(eventId);
  return match?.[1] ?? null;
}

async function fetchPostproductionControlSnapshot(projectId: string, token: string): Promise<{
  state: MatchState; teams: Team[];
}> {
  const response = await fetch(`/api/postproduction-control/${encodeURIComponent(projectId)}/state`, {
    headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(controlResponseError(payload));
  return controlSnapshot(payload);
}

function controlSnapshot(payload: unknown): { state: MatchState; teams: Team[] } {
  if (typeof payload !== 'object' || payload === null) throw new Error('El runtime devolvió un estado de renovación no válido.');
  const value = payload as { state?: unknown; teams?: unknown };
  if (typeof value.state !== 'object' || value.state === null || !Array.isArray(value.teams)) {
    throw new Error('El runtime devolvió un estado de renovación no válido.');
  }
  return { state: value.state as MatchState, teams: value.teams as Team[] };
}

function controlResponseError(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'El runtime rechazó la orden del operador.';
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return 'El runtime rechazó la orden del operador.';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'El runtime rechazó la orden del operador.';
}

function toPostproductionCommand(event: RpcEventName, payload: Record<string, unknown>) {
  const base = { expectedVersion: payload.expectedVersion, commandId: payload.commandId };
  switch (event) {
    case 'score:addPoint': return { ...base, kind: 'add_point', payload: { side: payload.side } };
    case 'score:undo': return { ...base, kind: 'undo', payload: {} };
    case 'score:resetMatch': return { ...base, kind: 'reset', payload: {} };
    case 'score:manualPatch': return { ...base, kind: 'manual_patch', payload: { patch: payload.patch } };
    case 'match:updateMeta': return { ...base, kind: 'update_meta', payload: { patch: payload.patch } };
    case 'match:setStatus': return { ...base, kind: 'set_status', payload: { status: payload.status } };
    case 'overlay:updateSettings': return { ...base, kind: 'update_overlay', payload: { patch: payload.patch } };
    case 'match:useCard': return { ...base, kind: 'use_card', payload: { side: payload.side, cardId: payload.cardId, cardName: payload.cardName } };
    case 'overlay:triggerDataScene': return { ...base, kind: 'trigger_data_scene', payload: { kind: payload.kind, target: payload.target } };
    case 'overlay:updateSponsorTicker': return { ...base, kind: 'update_sponsor_ticker', payload: { patch: payload.patch } };
    case 'overlay:triggerSponsorFullscreen': return { ...base, kind: 'trigger_sponsor_ad', payload: {
      sponsorIds: payload.sponsorIds, durationSeconds: payload.durationSeconds,
    } };
    case 'match:newMatch': throw new Error('Una renovación solo controla el partido asociado al vídeo.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}

function toRpcCall(
  event: RpcEventName,
  payload: Record<string, unknown>,
): { rpcName: string; params: Record<string, unknown> } {
  const base = {
    p_court_slug: payload.eventId,
    p_expected_version: payload.expectedVersion,
    p_command_id: payload.commandId,
  };

  if (event === 'score:addPoint') {
    return { rpcName: 'add_point', params: { ...base, p_side: payload.side } };
  }

  if (event === 'score:undo') {
    return { rpcName: 'undo_last', params: base };
  }

  if (event === 'score:resetMatch') {
    return { rpcName: 'reset_match', params: base };
  }

  if (event === 'score:manualPatch') {
    return { rpcName: 'manual_patch', params: { ...base, p_patch: payload.patch } };
  }

  if (event === 'match:updateMeta') {
    return { rpcName: 'update_match_meta', params: { ...base, p_patch: payload.patch } };
  }

  if (event === 'match:setStatus') {
    return { rpcName: 'set_match_status', params: { ...base, p_status: payload.status } };
  }

  if (event === 'overlay:updateSettings') {
    return { rpcName: 'update_overlay_settings', params: { ...base, p_patch: payload.patch } };
  }

  if (event === 'match:useCard') {
    return {
      rpcName: 'use_match_card',
      params: {
        ...base,
        p_side: payload.side,
        p_card_id: payload.cardId,
        p_card_name: payload.cardName,
      },
    };
  }

  if (event === 'overlay:triggerDataScene') {
    return {
      rpcName: 'trigger_overlay_data_scene',
      params: {
        ...base,
        p_kind: payload.kind,
        p_target: payload.target,
      },
    };
  }

  if (event === 'overlay:updateSponsorTicker') {
    return {
      rpcName: 'update_sponsor_ticker',
      params: { ...base, p_patch: payload.patch },
    };
  }

  if (event === 'overlay:triggerSponsorFullscreen') {
    return {
      rpcName: 'trigger_sponsor_fullscreen',
      params: {
        ...base,
        p_sponsor_ids: payload.sponsorIds,
        p_duration_seconds: payload.durationSeconds ?? null,
      },
    };
  }

  return { rpcName: 'new_match', params: { ...base, p_setup: payload.setup } };
}
