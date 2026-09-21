import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ProductionAccessGuard } from '../production/production-access.js';
import { PilotServiceError } from '../pilot/pilot-service-error.js';
import { browsePostproductionSources } from './postproduction-source-browser.js';
import type { PostproductionService } from './postproduction-service.js';

export function registerPostproductionRoutes(app: FastifyInstance, dependencies: {
  readonly sourceRoot: string;
  readonly postproduction: PostproductionService;
  readonly productionAccess: ProductionAccessGuard;
  readonly requireLocal: (ip: string) => void;
}): void {
  const { sourceRoot, postproduction, productionAccess, requireLocal } = dependencies;
  const admin = async (ip: string, authorization: string | undefined) => {
    requireLocal(ip); await productionAccess.require(authorization, 'production_admin');
  };

  app.get<{ Querystring: { path?: string } }>('/api/pilot/postproduction/sources', async (request) => {
    await admin(request.ip, request.headers.authorization);
    try { return await browsePostproductionSources(sourceRoot, request.query.path); }
    catch (error) { throw new PilotServiceError(400, 'INVALID_INPUT', error instanceof Error ? error.message : 'No se puede abrir la carpeta.'); }
  });

  app.get('/api/pilot/postproduction/projects', async (request) => {
    await admin(request.ip, request.headers.authorization); return { projects: postproduction.list() };
  });
  app.post('/api/pilot/postproduction/projects', async (request, reply) => {
    await admin(request.ip, request.headers.authorization);
    reply.status(201).send({ project: await postproduction.create(request.body) });
  });
  app.get<{ Params: { projectId: string } }>('/api/pilot/postproduction/projects/:projectId', async (request) => {
    await admin(request.ip, request.headers.authorization); return { project: postproduction.get(request.params.projectId) };
  });
  app.put<{ Params: { projectId: string } }>('/api/pilot/postproduction/projects/:projectId/checkpoint', async (request) => {
    await admin(request.ip, request.headers.authorization);
    return { project: await postproduction.checkpoint(request.params.projectId, request.body) };
  });
  app.post<{ Params: { projectId: string } }>('/api/pilot/postproduction/projects/:projectId/relink', async (request) => {
    await admin(request.ip, request.headers.authorization);
    return { project: await postproduction.relink(request.params.projectId, request.body) };
  });
  app.post<{ Params: { projectId: string } }>('/api/pilot/postproduction/projects/:projectId/render', async (request) => {
    await admin(request.ip, request.headers.authorization); return { project: await postproduction.startRender(request.params.projectId) };
  });
  app.post<{ Params: { projectId: string } }>('/api/pilot/postproduction/projects/:projectId/render/cancel', async (request) => {
    await admin(request.ip, request.headers.authorization); return { project: await postproduction.cancelRender(request.params.projectId) };
  });
  app.post<{ Params: { projectId: string } }>('/api/pilot/postproduction/projects/:projectId/media-token', async (request) => {
    await admin(request.ip, request.headers.authorization);
    const token = postproduction.issueMediaToken(request.params.projectId);
    return { url: `/api/pilot/postproduction/projects/${encodeURIComponent(request.params.projectId)}/media?token=${encodeURIComponent(token)}` };
  });
  app.get<{ Params: { projectId: string }; Querystring: { token?: string } }>(
    '/api/pilot/postproduction/projects/:projectId/media', async (request, reply) => {
      requireLocal(request.ip);
      const path = await postproduction.mediaPath(request.params.projectId, request.query.token ?? '');
      const info = await stat(path);
      const range = parseRange(request.headers.range, info.size);
      reply.header('Accept-Ranges', 'bytes'); reply.header('Content-Type', 'video/mp4');
      if (!range) {
        reply.header('Content-Length', info.size); return reply.send(createReadStream(path));
      }
      reply.status(206); reply.header('Content-Length', range.end - range.start + 1);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      return reply.send(createReadStream(path, range));
    },
  );
  app.get<{ Params: { projectId: string }; Querystring: { token?: string } }>(
    '/api/pilot/postproduction/projects/:projectId/render-state', async (request) => {
      requireLocal(request.ip); return postproduction.renderState(request.params.projectId, request.query.token ?? '');
    },
  );
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) throw new PilotServiceError(416, 'INVALID_INPUT', 'El rango de vídeo no es válido.');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] ?? 0));
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= size) {
    throw new PilotServiceError(416, 'INVALID_INPUT', 'El rango de vídeo está fuera del archivo.');
  }
  return { start, end };
}
