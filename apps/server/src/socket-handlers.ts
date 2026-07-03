import {
  ScoreEngineError,
  addPoint,
  applyManualPatch,
  resetMatch,
  setMatchStatus,
  startNewMatch,
  triggerOverlayDataScene,
  undoLastScoringCommand,
  updateMatchMeta,
  updateOverlaySettings,
  useMatchCard,
} from '@kpl/shared';
import type {
  Ack,
  ClientRole,
  ClientToServerEvents,
  CommandError,
  MatchState,
  ServerToClientEvents,
  StateUpdatedPayload,
  VersionedCommandPayload,
} from '@kpl/shared';
import type { Server, Socket } from 'socket.io';
import type { FileStore } from './file-store.js';
import { commandError } from './http-error.js';

export interface SocketData {
  eventId?: string;
  role?: ClientRole;
  authorizedControl?: boolean;
}

export type KplSocketServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
type KplSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

export interface SocketHandlerOptions {
  io: KplSocketServer;
  store: FileStore;
  controlPin: string | null;
}

export function registerSocketHandlers(options: SocketHandlerOptions): void {
  options.io.on('connection', (socket) => {
    socket.on('join:event', async (payload, ack) => {
      try {
        if (!payload.eventId || !payload.role) {
          ack(fail('BAD_REQUEST', 'eventId y role son obligatorios.'));
          return;
        }

        if (payload.role === 'control' && options.controlPin && payload.pin !== options.controlPin) {
          ack(fail('FORBIDDEN', 'PIN de control incorrecto.'));
          return;
        }

        const state = await options.store.getEventState(payload.eventId);

        if (socket.data.eventId) {
          await socket.leave(roomName(socket.data.eventId));
        }

        socket.data.eventId = payload.eventId;
        socket.data.role = payload.role;
        socket.data.authorizedControl = payload.role === 'control';
        await socket.join(roomName(payload.eventId));
        ack(ok(state));
      } catch (error) {
        ack(fail('NOT_FOUND', errorMessage(error)));
      }
    });

    socket.on('score:addPoint', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        addPoint(state, payload.side, payload.commandId),
      ),
    );

    socket.on('score:undo', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        undoLastScoringCommand(state, payload.commandId),
      ),
    );

    socket.on('score:resetMatch', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        resetMatch(state, payload.commandId),
      ),
    );

    socket.on('score:manualPatch', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        applyManualPatch(state, payload.patch, payload.commandId),
      ),
    );

    socket.on('match:updateMeta', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        updateMatchMeta(state, payload.patch, payload.commandId),
      ),
    );

    socket.on('match:setStatus', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        setMatchStatus(state, payload.status, payload.commandId),
      ),
    );

    socket.on('match:newMatch', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        startNewMatch(state, payload.setup, payload.commandId),
      ),
    );

    socket.on('overlay:updateSettings', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        updateOverlaySettings(state, payload.patch, payload.commandId),
      ),
    );

    socket.on('match:useCard', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        useMatchCard(state, payload.side, payload.cardId, payload.cardName, payload.commandId),
      ),
    );

    socket.on('overlay:triggerDataScene', (payload, ack) =>
      runControlCommand(options, socket, payload, ack, (state) =>
        triggerOverlayDataScene(state, payload.kind, payload.target, payload.commandId),
      ),
    );
  });
}

async function runControlCommand<TPayload extends VersionedCommandPayload>(
  options: SocketHandlerOptions,
  socket: KplSocket,
  payload: TPayload,
  ack: (response: Ack<MatchState>) => void,
  action: (state: MatchState) => MatchState,
): Promise<void> {
  try {
    if (!socket.data.authorizedControl || socket.data.role !== 'control') {
      ack(fail('FORBIDDEN', 'Este socket no esta autorizado para controlar el marcador.'));
      return;
    }

    if (socket.data.eventId !== payload.eventId) {
      ack(fail('BAD_REQUEST', 'El socket no esta unido a ese evento.'));
      return;
    }

    const next = await options.store.updateEventState(payload.eventId, (current) => {
      if (hasCommand(current, payload.commandId)) {
        return current;
      }

      if (current.version !== payload.expectedVersion) {
        throw commandError('VERSION_CONFLICT', 'El marcador ha cambiado en otro dispositivo.', current);
      }

      return action(current);
    });

    ack(ok(next));
    emitState(options.io, payload.eventId, next);
  } catch (error) {
    ack(toAckError(error));
  }
}

function emitState(io: KplSocketServer, eventId: string, state: MatchState): void {
  const payload: StateUpdatedPayload = { eventId, state };
  io.to(roomName(eventId)).emit('state:updated', payload);
}

function hasCommand(state: MatchState, commandId: string): boolean {
  return state.history.some((entry) => entry.commandId === commandId);
}

function roomName(eventId: string): string {
  return `event:${eventId}`;
}

function ok<T>(data: T): Ack<T> {
  return { ok: true, data };
}

function fail(code: CommandError['code'], message: string, currentVersion?: number): Ack<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(currentVersion !== undefined ? { currentVersion } : {}),
    },
  };
}

function toAckError(error: unknown): Ack<never> {
  if (error instanceof ScoreEngineError) {
    return fail(error.code, error.message);
  }

  if (isCommandError(error)) {
    return { ok: false, error };
  }

  return fail('SERVER_ERROR', errorMessage(error));
}

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as CommandError).code === 'string' &&
    typeof (error as CommandError).message === 'string'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}
