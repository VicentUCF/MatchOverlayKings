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
import { PilotService, PilotServiceError } from './pilot-service.js';
import { PilotYouTubeGateway } from './pilot-youtube.js';

export async function buildApp(config: ServerConfig) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });
  const store = new FileStore(config.dataDir);
  const pilot = new PilotService(config.pilot.ffmpegPath, new PilotYouTubeGateway(config.pilot.youtube));
  await pilot.initialize();
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
    if (error instanceof PilotServiceError) {
      reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
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

  app.get('/api/pilot/readiness', async (request) => {
    requireLocalPilot(request.ip);
    return pilot.readiness();
  });

  app.get('/api/pilot/sessions', async (request) => {
    requireLocalPilot(request.ip);
    return { sessions: await pilot.list() };
  });

  app.post('/api/pilot/sessions', async (request, reply) => {
    requireLocalPilot(request.ip);
    const session = await pilot.prepare(request.body);
    reply.status(201).send({ session });
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/start', async (request) => {
    requireLocalPilot(request.ip);
    return { session: pilot.start(request.params.sessionId) };
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/stop', async (request) => {
    requireLocalPilot(request.ip);
    return { session: await pilot.stop(request.params.sessionId) };
  });

  app.get<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/thumbnail', async (request, reply) => {
    requireLocalPilot(request.ip);
    reply.type('image/png').send(Buffer.from(pilot.thumbnail(request.params.sessionId)));
  });

  app.get('/api/pilot/youtube/auth/start', async (_request, reply) => {
    requireLocalPilot(_request.ip);
    reply.redirect(pilot.authorizationUrl());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/pilot/youtube/auth/callback',
    async (request, reply) => {
      requireLocalPilot(request.ip);
      if (request.query.error || !request.query.code || !request.query.state) {
        throw new PilotServiceError(400, 'INVALID_INPUT', 'YouTube no autorizó la conexión.');
      }
      await pilot.completeAuthorization(request.query.code, request.query.state);
      reply.redirect('/admin?pilot=1');
    },
  );

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
    await pilot.shutdown();
    await io.close();
  });

  return { app, io, store };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}

function requireLocalPilot(ip: string): void {
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    throw new PilotServiceError(403, 'FORBIDDEN', 'El control del piloto solo está disponible desde este PC.');
  }
}
