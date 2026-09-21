import type { FastifyInstance } from 'fastify';
import type { ProductionAccessGuard } from '../../production-access.js';
import { PilotServiceError } from '../../pilot-service-error.js';
import { browseRecordingDirectories } from './recording-directory-browser.js';
import type { RecordingLibrary } from './recording-library.js';

export function registerRecordingRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly dataDirectory: string;
    readonly recordings: RecordingLibrary;
    readonly productionAccess: ProductionAccessGuard;
    readonly requireLocal: (ip: string) => void;
  },
): void {
  const { dataDirectory, recordings, productionAccess, requireLocal } = dependencies;

  app.get<{ Querystring: { path?: string } }>('/api/pilot/recording-directories', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    try {
      return await browseRecordingDirectories(dataDirectory, request.query.path);
    } catch (error) {
      throw new PilotServiceError(400, 'INVALID_INPUT',
        error instanceof Error ? error.message : 'No se puede abrir esta carpeta.');
    }
  });

  app.get('/api/pilot/recordings', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { assets: recordings.listAssets(), jobs: recordings.listJobs() };
  });

  app.post<{ Params: { assetId: string } }>('/api/pilot/recordings/:assetId/uploads', async (request, reply) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    const job = await recordings.createUpload(request.params.assetId, request.body);
    reply.status(201).send({ job });
  });

  app.post<{ Params: { jobId: string } }>('/api/pilot/publications/:jobId/pause', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { job: await recordings.pause(request.params.jobId) };
  });

  app.post<{ Params: { jobId: string } }>('/api/pilot/publications/:jobId/resume', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { job: await recordings.resume(request.params.jobId) };
  });

  app.post<{ Params: { jobId: string } }>('/api/pilot/publications/:jobId/retry', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { job: await recordings.retryReconciliation(request.params.jobId) };
  });

  app.post<{ Params: { jobId: string } }>('/api/pilot/publications/:jobId/schedule', async (request) => {
    requireLocal(request.ip);
    await productionAccess.require(request.headers.authorization, 'production_admin');
    return { job: await recordings.schedule(request.params.jobId, request.body) };
  });
}
