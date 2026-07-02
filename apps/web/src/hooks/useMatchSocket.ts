import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  Ack,
  ClientRole,
  ClientToServerEvents,
  ManualScorePatch,
  MatchMetaPatch,
  MatchState,
  NewMatchSetup,
  ServerToClientEvents,
  Side,
  Team,
} from '@kpl/shared';
import { createCommandId } from '../command-id.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
type CommandEventName = Exclude<keyof ClientToServerEvents, 'join:event'>;

export interface EventSummary {
  id: string;
  title: string;
  courtName: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchState['status'];
  version: number;
  updatedAt: string;
}

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
  const socketRef = useRef<ClientSocket | null>(null);
  const stateRef = useRef<MatchState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshEvents = useCallback(async () => {
    const response = await fetch(eventsEndpoint(role), eventsFetchOptions(role, pin));
    const payload = (await response.json()) as { events: EventSummary[] };
    setEvents(payload.events);
  }, [pin, role]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const [teamsResponse, eventsResponse, stateResponse] = await Promise.all([
          fetch('/api/teams'),
          fetch(eventsEndpoint(role), eventsFetchOptions(role, pin)),
          fetch(`/api/events/${eventId}/state`),
        ]);

        if (!teamsResponse.ok || !eventsResponse.ok || !stateResponse.ok) {
          throw new Error('No se pudo cargar el evento.');
        }

        const teamsPayload = (await teamsResponse.json()) as { teams: Team[] };
        const eventsPayload = (await eventsResponse.json()) as { events: EventSummary[] };
        const statePayload = (await stateResponse.json()) as { state: MatchState };

        if (!cancelled) {
          setTeams(teamsPayload.teams);
          setEvents(eventsPayload.events);
          setState(statePayload.state);
          stateRef.current = statePayload.state;
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
  }, [eventId, pin, role]);

  useEffect(() => {
    const socket: ClientSocket = io({
      transports: ['websocket'],
      reconnection: true,
    });
    socketRef.current = socket;
    setConnectionState('connecting');

    socket.on('connect', () => {
      const joinPayload = pin ? { eventId, role, pin } : { eventId, role };

      socket.emit('join:event', joinPayload, (response) => {
        if (response.ok) {
          setState(response.data);
          stateRef.current = response.data;
          setConnectionState('connected');
          setError(null);
        } else {
          setConnectionState('error');
          setError(response.error.message);
        }
      });
    });

    socket.on('disconnect', () => {
      setConnectionState('disconnected');
    });

    socket.on('connect_error', (connectError) => {
      setConnectionState('error');
      setError(connectError.message);
    });

    socket.on('state:updated', (payload) => {
      if (payload.eventId === eventId) {
        setState(payload.state);
        stateRef.current = payload.state;
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [eventId, pin, role]);

  const send = useCallback(
    async <TEvent extends CommandEventName>(
      event: TEvent,
      payload: Omit<Parameters<ClientToServerEvents[TEvent]>[0], 'eventId' | 'expectedVersion' | 'commandId'>,
    ) => {
      const socket = socketRef.current;
      const current = stateRef.current;

      if (!socket || !current) {
        setError('Socket no conectado.');
        return false;
      }

      setPending(true);
      setError(null);

      try {
        return await new Promise<boolean>((resolve) => {
          const commandPayload = {
            ...payload,
            eventId,
            expectedVersion: current.version,
            commandId: createCommandId(),
          };

          const callback = (response: Ack<MatchState>) => {
            if (response.ok) {
              setState(response.data);
              stateRef.current = response.data;
              resolve(true);
            } else {
              setError(response.error.message);
              resolve(false);
            }
          };
          const args = [
            commandPayload,
            callback,
          ] as unknown as Parameters<ClientToServerEvents[TEvent]>;

          socket.emit(event, ...args);
        });
      } catch (sendError) {
        setError(errorMessage(sendError));
        return false;
      } finally {
        setPending(false);
      }
    },
    [eventId],
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

function eventsEndpoint(role: ClientRole): string {
  return role === 'control' ? '/api/admin/events' : '/api/events';
}

function eventsFetchOptions(role: ClientRole, pin: string): RequestInit | undefined {
  if (role !== 'control') {
    return undefined;
  }

  return pin ? { headers: { 'x-control-pin': pin } } : undefined;
}
