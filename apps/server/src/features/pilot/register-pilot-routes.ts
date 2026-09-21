import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RecordingLibrary } from '../recordings/recording-library.js';
import { PilotOperationError } from './pilot-operation-journal.js';
import type { PilotService } from './pilot-service.js';
import { PilotServiceError } from './pilot-service-error.js';
import type { ProductionAccessGuard } from '../production/production-access.js';

export function registerPilotRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly pilot: PilotService;
    readonly recordings: RecordingLibrary;
    readonly productionAccess: ProductionAccessGuard;
    readonly requireLocal: (ip: string) => void;
  },
): void {
  const { pilot, recordings, productionAccess, requireLocal } = dependencies;

  app.get('/api/pilot/sessions', async (request) => {
    requireLocal(request.ip);
    return { sessions: pilot.snapshot() };
  });

  app.get('/api/pilot/operations', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'operator');
    return { operations: pilot.operationHistory() };
  });

  app.get('/api/pilot/incidents', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'operator');
    return { incidents: pilot.incidentHistory() };
  });

  app.get('/api/pilot/configurations', async (request) => {
    requireLocal(request.ip);
    return { configurations: pilot.configurations() };
  });

  app.put<{ Params: { courtSlug: string } }>('/api/pilot/configurations/:courtSlug', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { configuration: await pilot.configure(
      request.params.courtSlug, request.body, request.headers.authorization, operationId(request),
    ) };
  });

  app.post('/api/pilot/thumbnail-preview', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { dataUrl: `data:image/png;base64,${Buffer.from(pilot.previewThumbnail(request.body)).toString('base64')}` };
  });

  app.post('/api/pilot/sessions', async (request, reply) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const session = await pilot.prepare(request.body, request.headers.authorization, operationId(request));
    reply.status(201).send({ session });
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/start', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const session = await pilot.start(request.params.sessionId, request.headers.authorization, operationId(request));
    await recordings.reconcileSession(session, pilot.configurations());
    return { session };
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/preflight', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { session: await pilot.preflight(
      request.params.sessionId, request.body, request.headers.authorization, operationId(request),
    ) };
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/preflight/cancel', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { session: await pilot.cancelPreflight(request.params.sessionId) };
  });

  app.get<{ Params: { sessionId: string; runId: string } }>(
    '/api/pilot/sessions/:sessionId/preflight-preview/:runId',
    async (request, reply) => {
      requireLocal(request.ip);
      await productionAccess.require(request.headers.authorization, 'production_admin');
      reply.header('cache-control', 'no-store').type('video/mp4');
      return reply.send(await pilot.preflightPreview(request.params.sessionId, request.params.runId));
    },
  );

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/recover', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const session = await pilot.recover(request.params.sessionId, request.headers.authorization, operationId(request));
    await recordings.reconcileSession(session, pilot.configurations());
    return { session };
  });

  app.post<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/stop', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const session = await pilot.stop(request.params.sessionId, request.headers.authorization, operationId(request));
    await recordings.reconcileSession(session, pilot.configurations());
    return { session };
  });

  app.get<{ Params: { sessionId: string } }>('/api/pilot/sessions/:sessionId/thumbnail', async (request, reply) => {
    requireLocal(request.ip);
    reply.type('image/png').send(Buffer.from(pilot.thumbnail(request.params.sessionId)));
  });

  app.get('/api/pilot/youtube/auth/start', async (request, reply) => {
    requireLocal(request.ip);
    reply.redirect(pilot.authorizationUrl());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/pilot/youtube/auth/callback',
    async (request, reply) => {
      requireLocal(request.ip);
      if (request.query.error || !request.query.code || !request.query.state) {
        throw new PilotServiceError(400, 'INVALID_INPUT', 'YouTube no autorizó la conexión.');
      }
      await pilot.completeAuthorization(request.query.code, request.query.state);
      reply.redirect('/admin');
    },
  );
}

function operationId(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) throw new PilotOperationError('Usa un único identificador de operación.');
  return value;
}
