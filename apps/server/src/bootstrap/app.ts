import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { dirname, join, resolve } from 'node:path';
import { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@kpl/shared';
import { FileStore } from '../core/file-store.js';
import type { ServerConfig } from './config.js';
import { HttpCommandError } from '../core/http-error.js';
import { registerSocketHandlers } from '../realtime/socket-handlers.js';
import type { KplSocketServer, SocketData } from '../realtime/socket-handlers.js';
import { SupabasePilotMatchBinding, type PilotMatchBinding } from '../features/pilot/pilot-match-binding.js';
import { SupabasePilotStreamLink, type PilotStreamLink } from '../features/pilot/pilot-stream-link.js';
import { PilotOperationError } from '../features/pilot/pilot-operation-journal.js';
import { PilotService } from '../features/pilot/pilot-service.js';
import { PilotServiceError } from '../features/pilot/pilot-service-error.js';
import { PilotYouTubeGateway } from '../features/pilot/pilot-youtube.js';
import { PilotMobileCameraError, PilotMobileCameraService } from '../features/pilot/pilot-mobile-camera.js';
import { BrowserPilotOverlayRenderer, type PilotOverlayRenderer } from '../features/pilot/pilot-overlay.js';
import { SupabaseProductionAccessGuard, type ProductionAccessGuard } from '../features/production/production-access.js';
import { RecordingLibrary } from '../features/recordings/recording-library.js';
import { registerRecordingRoutes } from '../features/recordings/register-recording-routes.js';
import { registerPilotRoutes } from '../features/pilot/register-pilot-routes.js';
import {
  InMemoryPublicationTaskQueue,
  RabbitMqPublicationTaskQueue,
  type PublicationTaskQueue,
} from '../infrastructure/queues/publication-task-queue.js';
import { ProductionEventBus, productionSseEvent, type ProductionEventScope } from '../features/production/production-events.js';
import { PostproductionService } from '../features/postproduction/postproduction-service.js';
import { registerPostproductionRoutes } from '../features/postproduction/register-postproduction-routes.js';

export async function buildApp(
  config: ServerConfig,
  dependencies: {
    readonly mobileCameraReadinessProbe?: ConstructorParameters<typeof PilotMobileCameraService>[3];
    readonly mobileCameraVersionProbe?: ConstructorParameters<typeof PilotMobileCameraService>[4];
    readonly mobileCameraNow?: ConstructorParameters<typeof PilotMobileCameraService>[5];
    readonly mobileCameraApiMutation?: ConstructorParameters<typeof PilotMobileCameraService>[6];
    readonly mobileCameraHealthProbe?: ConstructorParameters<typeof PilotMobileCameraService>[7];
    readonly pilotOverlayRenderer?: PilotOverlayRenderer;
    readonly pilotMatchBinding?: PilotMatchBinding;
    readonly pilotStreamLink?: PilotStreamLink;
    readonly pilotPreflight?: ConstructorParameters<typeof PilotService>[8];
    readonly productionAccessGuard?: ProductionAccessGuard;
    readonly publicationTaskQueue?: PublicationTaskQueue;
    readonly productionEventBus?: ProductionEventBus;
  } = {},
) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        // OAuth callbacks carry one-time codes in the query string.
        req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0] ?? '/' }),
        err: () => ({ type: 'Error', message: 'Error interno; consultar el identificador de diagnóstico.', stack: '' }),
      },
    },
  });
  const productionEvents = dependencies.productionEventBus ?? new ProductionEventBus();
  const store = new FileStore(config.dataDir);
  const mobileCamera = new PilotMobileCameraService(
    config.pilot.mobileCamera,
    resolve(config.dataDir, 'mobile-camera-runtime'),
    config.port,
    dependencies.mobileCameraReadinessProbe,
    dependencies.mobileCameraVersionProbe,
    dependencies.mobileCameraNow,
    dependencies.mobileCameraApiMutation,
    dependencies.mobileCameraHealthProbe,
    () => productionEvents.publish('runtime'),
  );
  const browserPath = chromiumExecutablePath();
  const overlayRenderer = dependencies.pilotOverlayRenderer ?? new BrowserPilotOverlayRenderer({
    baseUrl: `http://127.0.0.1:${config.port}`,
    ...(browserPath ? { chromiumExecutablePath: browserPath } : {}),
  });
  const youtube = new PilotYouTubeGateway(config.pilot.youtube);
  const pilot = new PilotService(
    config.pilot.ffmpegPath,
    youtube,
    resolve(config.dataDir, 'pilot-configurations.json'),
    mobileCamera,
    overlayRenderer,
    dependencies.pilotMatchBinding ?? new SupabasePilotMatchBinding(config.pilot.supabase),
    dependencies.pilotStreamLink ?? new SupabasePilotStreamLink(config.pilot.supabase),
    undefined,
    dependencies.pilotPreflight,
    (scope) => productionEvents.publish(scope),
  );
  const productionAccess = dependencies.productionAccessGuard
    ?? new SupabaseProductionAccessGuard(config.pilot.supabase);
  const publicationTasks = dependencies.publicationTaskQueue
    ?? (config.rabbitMq == null
      ? new InMemoryPublicationTaskQueue()
      : new RabbitMqPublicationTaskQueue(config.rabbitMq.url, config.rabbitMq.queuePrefix, (event) => {
        if (event.type === 'connected') app.log.info({ queue: config.rabbitMq?.queuePrefix }, 'RabbitMQ publication queue connected');
        else app.log.warn({ queue: config.rabbitMq?.queuePrefix, ...event }, 'RabbitMQ publication queue state changed');
      }));
  await pilot.initialize();
  const recordings = new RecordingLibrary(
    resolve(config.dataDir, 'recording-library.json'),
    join(dirname(config.pilot.ffmpegPath), 'ffprobe'),
    youtube,
    publicationTasks,
    () => productionEvents.publish('recordings'),
  );
  const postproduction = new PostproductionService(
    config.dataDir,
    config.postproductionSourceRoot ?? resolve(config.dataDir, 'imports'),
    config.postproductionOutputRoot ?? resolve(config.dataDir, 'exports'),
    config.pilot.ffmpegPath,
    join(dirname(config.pilot.ffmpegPath), 'ffprobe'),
    `http://127.0.0.1:${config.port}`,
    join(config.webDistDir, 'sounds', 'card-reveal.mp3'),
    overlayRenderer,
    recordings,
    () => pilot.snapshot().some((session) => ['starting', 'live', 'reconnecting', 'stopping'].includes(session.status)),
    () => productionEvents.publish('postproduction'),
  );
  try {
    await recordings.initialize();
    await postproduction.initialize();
    for (const session of pilot.snapshot()) await recordings.reconcileSession(session, pilot.configurations());
    await mobileCamera.initialize();
    await pilot.flushOperationalHistory();
  } catch (error) {
    await Promise.allSettled([postproduction.shutdown(), recordings.shutdown(), pilot.shutdown(), mobileCamera.shutdown()]);
    productionEvents.close();
    throw error;
  }
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PilotServiceError || error instanceof PilotMobileCameraError || error instanceof PilotOperationError) {
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

    request.log.error({ diagnosticId: request.id }, 'No se pudo completar la solicitud.');
    reply.status(500).send({ error: { code: 'SERVER_ERROR',
      message: `No se pudo completar la solicitud. Comprueba el estado de la pista antes de reintentar. Diagnóstico: ${request.id}.`,
    } });
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

  app.get('/api/pilot/runtime-snapshot', async (request) => {
    requireLocalPilot(request.ip);
    return {
      readiness: pilot.readiness(),
      sessions: pilot.snapshot(),
      mobileCameras: mobileCamera.list(),
    };
  });

  app.get('/api/pilot/events', async (request, reply) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();
    reply.raw.flushHeaders();
    reply.raw.write('retry: 3000\n\n');
    const scopes: readonly ProductionEventScope[] = ['runtime', 'configurations', 'recordings', 'postproduction'];
    for (const scope of scopes) reply.raw.write(productionSseEvent(productionEvents.snapshot(scope)));
    const unsubscribe = productionEvents.subscribe(
      (event) => { reply.raw.write(productionSseEvent(event)); },
      () => { reply.raw.end(); },
    );
    const heartbeat = setInterval(() => { reply.raw.write(': keepalive\n\n'); }, 15_000);
    heartbeat.unref();
    // Reauthorize periodically by making the browser reconnect with its latest token.
    const expire = setTimeout(() => { reply.raw.end(); }, 5 * 60_000);
    expire.unref();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(expire);
      unsubscribe();
    };
    request.raw.once('close', cleanup);
    reply.raw.once('close', cleanup);
  });

  app.addHook('preClose', async () => { productionEvents.close(); });

  registerPilotRoutes(app, { pilot, recordings, productionAccess, requireLocal: requireLocalPilot });

  registerRecordingRoutes(app, {
    dataDirectory: config.dataDir,
    recordings,
    productionAccess,
    requireLocal: requireLocalPilot,
  });
  registerPostproductionRoutes(app, {
    sourceRoot: config.postproductionSourceRoot,
    operatorOrigin: config.pilot.mobileCamera?.lanHost
      ? `http://${config.pilot.mobileCamera.lanHost}:${config.port}`
      : `http://localhost:${config.port}`,
    postproduction,
    productionAccess,
    requireLocal: requireLocalPilot,
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
    return { mobileCamera: await mobileCamera.updateDesired(request.params.sessionId, request.body) };
  });

  app.delete<{ Params: { sessionId: string } }>('/api/pilot/mobile-camera/:sessionId', async (request) => {
    requireLocalPilot(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
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
    app.get('/admin/grabaciones', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/postproduction/:projectId/overlay', async (_request, reply) => reply.sendFile('index.html'));
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
    try { await postproduction.shutdown(); }
    finally {
      try { await recordings.shutdown(); }
      finally {
        try { await pilot.shutdown(); }
        finally {
          try { await mobileCamera.shutdown(); }
          finally { await io.close(); }
        }
      }
    }
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
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
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
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  reply.header('Access-Control-Allow-Private-Network', 'true');
  reply.header('Private-Network-Access-Name', 'kpl-production-runtime');
  reply.header('Private-Network-Access-ID', '02:4b:50:4c:00:01');
  reply.header('Access-Control-Max-Age', '600');
  reply.header('Vary', 'Origin');
}

function requireLocalPilot(ip: string): void {
  // Docker Compose may deliver a host-browser request through its dedicated gateway.
  // The value is intentionally an exact IP, never a broad LAN range.
  const dockerAdminHost = process.env.KPL_PILOT_ADMIN_HOST;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1' && ip !== dockerAdminHost) {
    throw new PilotServiceError(403, 'FORBIDDEN', 'El control de producción solo está disponible desde este PC.');
  }
}
