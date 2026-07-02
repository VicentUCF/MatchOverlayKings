import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClientRole,
  ClientToServerEvents,
  ManualScorePatch,
  MatchMetaPatch,
  MatchState,
  NewMatchSetup,
  Side,
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
  refreshEvents: () => Promise<void>;
}

export function useMatchSocket(eventId: string, role: ClientRole, pin: string): MatchSocketState {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [state, setState] = useState<MatchState | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const stateRef = useRef<MatchState | null>(null);
  void pin;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshEvents = useCallback(async () => {
    const nextEvents = await fetchEventSummaries({ liveOnly: role !== 'control' });
    setEvents(nextEvents);
  }, [role]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const [teamsPayload, eventsPayload, statePayload] = await Promise.all([
          fetchTeams(),
          fetchEventSummaries({ liveOnly: role !== 'control' }),
          fetchMatchState(eventId),
        ]);

        if (!cancelled) {
          setTeams(teamsPayload);
          setEvents(eventsPayload);
          setState(statePayload);
          stateRef.current = statePayload;
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
  }, [eventId, role]);

  useEffect(() => {
    setConnectionState('connecting');
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = subscribeToMatchState(eventId, (nextState) => {
        setState(nextState);
        stateRef.current = nextState;
        setConnectionState('connected');

        if (role !== 'control') {
          void fetchEventSummaries({ liveOnly: true }).then(setEvents).catch(() => undefined);
        }
      });
    } catch (subscribeError) {
      setError(errorMessage(subscribeError));
      setConnectionState('error');
    }

    return () => {
      unsubscribe?.();
    };
  }, [eventId, role]);

  useEffect(() => {
    if (role === 'control') {
      return undefined;
    }

    let cancelled = false;
    const refreshPublicState = async () => {
      try {
        const nextState = await fetchMatchState(eventId);

        if (cancelled) {
          return;
        }

        setState(nextState);
        stateRef.current = nextState;
        setConnectionState('connected');
        setError(null);
      } catch (refreshError) {
        if (!cancelled && !stateRef.current) {
          setError(errorMessage(refreshError));
          setConnectionState('error');
        }
      }
    };
    const intervalId = window.setInterval(() => {
      void refreshPublicState();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [eventId, role]);

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
        const { rpcName, params } = toRpcCall(event, commandPayload);
        const { data, error: rpcError } = await supabase.rpc(rpcName, params);

        if (rpcError) {
          setError(rpcError.message);
          return false;
        }

        const nextState = data as MatchState;
        setState(nextState);
        stateRef.current = nextState;
        await refreshEvents();
        return true;
      } catch (sendError) {
        setError(errorMessage(sendError));
        return false;
      } finally {
        setPending(false);
      }
    },
    [eventId, refreshEvents],
  );

  return useMemo(
    () => ({
      connectionState,
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
      refreshEvents,
    }),
    [connectionState, error, events, pending, refreshEvents, send, state, teams],
  );
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

  return { rpcName: 'new_match', params: { ...base, p_setup: payload.setup } };
}
