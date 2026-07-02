import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@kpl/shared';
import { FileStore } from './file-store.js';
import type { ServerConfig } from './config.js';
import { HttpCommandError } from './http-error.js';
import { registerSocketHandlers } from './socket-handlers.js';
import type { KplSocketServer, SocketData } from './socket-handlers.js';

export async function buildApp(config: ServerConfig) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });
  const store = new FileStore(config.dataDir);
  const io: KplSocketServer = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    never,
    SocketData
  >(
    app.server,
    {
      cors: {
        origin: true,
      },
    },
  );

  registerSocketHandlers({ io, store, controlPin: config.controlPin });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpCommandError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          currentVersion: error.currentVersion,
        },
      });
      return;
    }

    app.log.error(error);
    reply.status(500).send({ error: { code: 'SERVER_ERROR', message: errorMessage(error) } });
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'kpl-live-overlays',
    time: new Date().toISOString(),
  }));

  app.get('/api/teams', async () => ({
    teams: await store.getTeams(),
  }));

  app.get('/api/events', async () => ({
    events: (await store.listEvents()).filter((event) => event.status === 'live'),
  }));

  app.get('/api/admin/events', async (request, reply) => {
    if (config.controlPin && request.headers['x-control-pin'] !== config.controlPin) {
      reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'PIN de control incorrecto.',
        },
      });
      return;
    }

    return {
      events: await store.listEvents(),
    };
  });

  app.get<{ Params: { eventId: string } }>('/api/events/:eventId/state', async (request) => ({
    state: await store.getEventState(request.params.eventId),
  }));

  if (existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      decorateReply: true,
    });

    app.get('/admin', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/live/:eventId', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/control/:eventId', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/overlay/:eventId/scoreboard', async (_request, reply) => reply.sendFile('index.html'));
  } else {
    app.log.warn(`Web dist directory not found: ${config.webDistDir}`);
  }

  app.addHook('onClose', async () => {
    await io.close();
  });

  return { app, io, store };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}
