import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { resolve } from 'node:path';
import { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@kpl/shared';
import { FileStore } from './file-store.js';
import type { ServerConfig } from './config.js';
import { HttpCommandError } from './http-error.js';
import { registerSocketHandlers } from './socket-handlers.js';
import type { KplSocketServer, SocketData } from './socket-handlers.js';
import { SupabasePilotMatchBinding, type PilotMatchBinding } from './pilot-match-binding.js';
import { PilotService, PilotServiceError } from './pilot-service.js';
import { PilotYouTubeGateway } from './pilot-youtube.js';
import { PilotMobileCameraError, PilotMobileCameraService } from './pilot-mobile-camera.js';
import { BrowserPilotOverlayRenderer, type PilotOverlayRenderer } from './pilot-overlay.js';
import { SupabaseProductionAccessGuard, type ProductionAccessGuard } from './production-access.js';

export async function buildApp(
  config: ServerConfig,
  dependencies: {
    readonly mobileCameraReadinessProbe?: ConstructorParameters<typeof PilotMobileCameraService>[3];
    readonly mobileCameraVersionProbe?: ConstructorParameters<typeof PilotMobileCameraService>[4];
    readonly mobileCameraNow?: ConstructorParameters<typeof PilotMobileCameraService>[5];
    readonly mobileCameraApiMutation?: ConstructorParameters<typeof PilotMobileCameraService>[6];
    readonly pilotOverlayRenderer?: PilotOverlayRenderer;
    readonly pilotMatchBinding?: PilotMatchBinding;
    readonly productionAccessGuard?: ProductionAccessGuard;
  } = {},
) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });
  const store = new FileStore(config.dataDir);
  const mobileCamera = new PilotMobileCameraService(
    config.pilot.mobileCamera,
    resolve(config.dataDir, 'mobile-camera-runtime'),
    config.port,
    dependencies.mobileCameraReadinessProbe,
    dependencies.mobileCameraVersionProbe,
    dependencies.mobileCameraNow,
    dependencies.mobileCameraApiMutation,
  );
  mobileCamera.initialize();
  const browserPath = chromiumExecutablePath();
  const pilot = new PilotService(
    config.pilot.ffmpegPath,
    new PilotYouTubeGateway(config.pilot.youtube),
    resolve(config.dataDir, 'pilot-configurations.json'),
    mobileCamera,
    dependencies.pilotOverlayRenderer ?? new BrowserPilotOverlayRenderer({
      baseUrl: `http://127.0.0.1:${config.port}`,
      ...(browserPath ? { chromiumExecutablePath: browserPath } : {}),
    }),
    dependencies.pilotMatchBinding ?? new SupabasePilotMatchBinding(config.pilot.supabase),
  );
  const productionAccess = dependencies.productionAccessGuard
    ?? new SupabaseProductionAccessGuard(config.pilot.supabase);
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
    if (error instanceof PilotServiceError || error instanceof PilotMobileCameraError) {
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

  const pilotControlOrigins = new Set(config.pilot.controlOrigins
    ?? (config.pilot.mobileCamera === undefined ? [] : [config.pilot.mobileCamera.cameraPageOrigin]));
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/pilot/') || request.url === '/api/teams') {
      pilotControlCors(request, reply, pilotControlOrigins);
    }
  });
  app.options('/api/pilot/*', async (_request, reply) => reply.status(204).send());
  app.options('/api/teams', async (_request, reply) => reply.status(204).send());

  app.get('/health', async () => ({
    ok: true,
    service: 'kpl-live-overlays',
    time: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    const readiness = pilot.readiness();
    if (!readiness.ffmpeg.available) {
      reply.status(503);
    }
    return {
      ok: readiness.ffmpeg.available,
      service: 'kpl-live-overlays',
      ffmpeg: readiness.ffmpeg,
      time: new Date().toISOString(),
    };
  });

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

  app.get('/api/pilot/configurations', async (request) => {
    requireLocalPilot(request.ip);
    return { configurations: pilot.configurations() };
  });

  app.get('/api/pilot/mobile-camera', async (request) => {
    requireLocalPilot(request.ip);
    return { mobileCamera: mobileCamera.current() };
  });

  app.get('/api/pilot/mobile-cameras', async (request) => {
    requireLocalPilot(request.ip);
    return { mobileCameras: mobileCamera.list() };
  });

  app.post('/api/pilot/mobile-camera', async (request, reply) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const link = await mobileCamera.create(request.body);
    reply.status(201).send(link);
  });

  app.put<{ Params: { sessionId: string } }>('/api/pilot/mobile-camera/:sessionId/desired', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const current = mobileCamera.current(request.params.sessionId);
    if (current !== null && current.id === request.params.sessionId && pilot.isCourtActive(current.courtSlug)) {
      throw new PilotMobileCameraError(409, 'CONFLICT', 'Detén la emisión antes de cambiar cámara, FPS o audio.');
    }
    return { mobileCamera: mobileCamera.updateDesired(request.params.sessionId, request.body) };
  });

  app.delete<{ Params: { sessionId: string } }>('/api/pilot/mobile-camera/:sessionId', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const current = mobileCamera.current(request.params.sessionId);
    if (current !== null && current.id === request.params.sessionId && pilot.isCourtActive(current.courtSlug)) {
      throw new PilotMobileCameraError(409, 'CONFLICT', 'Detén la emisión antes de revocar la cámara.');
    }
    return { mobileCamera: await mobileCamera.revoke(request.params.sessionId) };
  });

  for (const path of [
    '/api/pilot/mobile-camera/:sessionId/claim',
    '/api/pilot/mobile-camera/:sessionId/desired',
    '/api/pilot/mobile-camera/:sessionId/status',
  ]) {
    app.options(path, async (request, reply) => {
      mobileCors(request, reply, config.pilot.mobileCamera?.cameraPageOrigin);
      reply.status(204).send();
    });
  }

  app.post<{ Params: { sessionId: string } }>('/api/pilot/mobile-camera/:sessionId/claim', async (request, reply) => {
    mobileCors(request, reply, config.pilot.mobileCamera?.cameraPageOrigin);
    return mobileCamera.claim(request.params.sessionId, bearerToken(request), request.body);
  });

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string } }>(
    '/api/pilot/mobile-camera/:sessionId/desired',
    async (request, reply) => {
      mobileCors(request, reply, config.pilot.mobileCamera?.cameraPageOrigin);
      const after = Number(request.query.after ?? 0);
      return { desired: await mobileCamera.waitForDesired(request.params.sessionId, bearerToken(request), after) };
    },
  );

  app.post<{ Params: { sessionId: string } }>('/api/pilot/mobile-camera/:sessionId/status', async (request, reply) => {
    mobileCors(request, reply, config.pilot.mobileCamera?.cameraPageOrigin);
    return { mobileCamera: mobileCamera.report(request.params.sessionId, bearerToken(request), request.body) };
  });

  app.put<{ Params: { courtSlug: string } }>('/api/pilot/configurations/:courtSlug', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { configuration: await pilot.configure(request.params.courtSlug, request.body, request.headers.authorization) };
  });

  app.post('/api/pilot/thumbnail-preview', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const png = pilot.previewThumbnail(request.body);
    return { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` };
  });

  app.post('/api/pilot/sessions', async (request, reply) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'operator');
    const session = await pilot.prepare(request.body, request.headers.authorization);
    reply.status(201).send({ session });
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/start', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'operator');
    return { session: await pilot.start(request.params.sessionId) };
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/recover', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'operator');
    return { session: await pilot.recover(request.params.sessionId) };
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/stop', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'operator');
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
      reply.redirect('/admin/emisiones');
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
    app.get('/admin/emisiones', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/admin/sistema', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/admin/sistema/configuracion', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/mandos', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/camera/pilot', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/live/:eventId', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/control/:eventId', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/overlay/:eventId/scoreboard', async (_request, reply) => reply.sendFile('index.html'));
  } else {
    app.log.warn(`Web dist directory not found: ${config.webDistDir}`);
  }

  app.addHook('onClose', async () => {
    await pilot.shutdown();
    await mobileCamera.shutdown();
    await io.close();
  });

  return { app, io, store };
}

function chromiumExecutablePath(): string | undefined {
  const configured = process.env.KPL_PILOT_CHROMIUM_PATH?.trim();
  if (configured) return configured;
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find((candidate) => existsSync(candidate));
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new PilotMobileCameraError(401, 'FORBIDDEN', 'Falta la autorización de la cámara.');
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (token.length < 32 || token.length > 128) {
    throw new PilotMobileCameraError(401, 'FORBIDDEN', 'La autorización de la cámara no es válida.');
  }
  return token;
}

function mobileCors(request: FastifyRequest, reply: FastifyReply, allowedOrigin: string | undefined): void {
  const origin = request.headers.origin;
  if (allowedOrigin === undefined || origin !== allowedOrigin) {
    throw new PilotMobileCameraError(403, 'FORBIDDEN', 'El origen de la cámara no está permitido.');
  }
  reply.header('Access-Control-Allow-Origin', allowedOrigin);
  // This path is shared by the Android long-poll (GET) and the production
  // panel's desired-camera update (PUT). Keep both methods in the preflight.
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  reply.header('Access-Control-Allow-Private-Network', 'true');
  reply.header('Private-Network-Access-Name', 'kpl-production-runtime');
  reply.header('Private-Network-Access-ID', '02:4b:50:4c:00:01');
  reply.header('Vary', 'Origin');
}

function pilotControlCors(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: ReadonlySet<string>,
): void {
  const requestOrigin = request.headers.origin;
  if (requestOrigin === undefined) return;
  const host = request.headers.host;
  const isSameServer = host !== undefined
    && (requestOrigin === `http://${host}` || requestOrigin === `https://${host}`);
  if (!isSameServer && !allowedOrigins.has(requestOrigin)) {
    throw new PilotServiceError(403, 'FORBIDDEN', 'El origen del control no está autorizado para usar el runtime local.');
  }
  reply.header('Access-Control-Allow-Origin', requestOrigin);
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  reply.header('Access-Control-Allow-Private-Network', 'true');
  reply.header('Private-Network-Access-Name', 'kpl-production-runtime');
  reply.header('Private-Network-Access-ID', '02:4b:50:4c:00:01');
  reply.header('Access-Control-Max-Age', '600');
  reply.header('Vary', 'Origin');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}

function requireLocalPilot(ip: string): void {
  // Docker Compose may deliver a host-browser request through its dedicated gateway.
  // The value is intentionally an exact IP, never a broad LAN range.
  const dockerAdminHost = process.env.KPL_PILOT_ADMIN_HOST;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1' && ip !== dockerAdminHost) {
    throw new PilotServiceError(403, 'FORBIDDEN', 'El control de producción solo está disponible desde este PC.');
  }
}
