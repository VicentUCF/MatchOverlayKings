import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PilotConfigurationSchema, PilotReadinessSchema, PilotSessionSchema } from '@kpl/production-contracts';
import { buildApp } from '../src/app.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('production pilot', () => {
  it('runs a real synthetic FFmpeg session without creating a YouTube broadcast', async () => {
    const app = await createPilotApp();

    const readinessResponse = await app.inject({ method: 'GET', url: '/api/pilot/readiness' });
    const readiness = PilotReadinessSchema.parse(readinessResponse.json());
    expect(readiness.ffmpeg.available).toBe(true);
    expect(readiness.sources[0]).toMatchObject({ id: 'synthetic', kind: 'synthetic' });
    expect(readiness.youtube).toMatchObject({ configured: false, authorized: false });

    const configurationPayload = {
      courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic',
      homeTeam: 'Red Lions', awayTeam: 'Kings', matchdayNumber: 1, seasonLabel: 'T2',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(), privacyStatus: 'private',
    } as const;
    const configureResponse = await app.inject({
      method: 'PUT', url: '/api/pilot/configurations/pista-1', payload: configurationPayload,
    });
    expect(configureResponse.statusCode).toBe(200);
    const configuration = PilotConfigurationSchema.parse(configureResponse.json().configuration);
    expect(configuration).toMatchObject(configurationPayload);
    const configurationsResponse = await app.inject({ method: 'GET', url: '/api/pilot/configurations' });
    expect(configurationsResponse.json().configurations).toEqual([configuration]);

    const wrongCourtResponse = await app.inject({
      method: 'PUT', url: '/api/pilot/configurations/pista-2', payload: configurationPayload,
    });
    expect(wrongCourtResponse.statusCode).toBe(400);

    const prepareResponse = await app.inject({
      method: 'POST', url: '/api/pilot/sessions', payload: configurationPayload,
    });
    expect(prepareResponse.statusCode).toBe(201);
    const prepared = PilotSessionSchema.parse(prepareResponse.json().session);
    expect(prepared).toMatchObject({ status: 'prepared', mode: 'simulation', broadcastId: null });

    const thumbnail = await app.inject({ method: 'GET', url: prepared.thumbnailUrl });
    expect(thumbnail.headers['content-type']).toContain('image/png');
    expect(thumbnail.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const startResponse = await app.inject({ method: 'POST', url: `/api/pilot/sessions/${prepared.id}/start` });
    expect(startResponse.statusCode).toBe(200);
    const live = await waitForSession(app, prepared.id, (session) =>
      session.status === 'live' && (session.encoder?.speed ?? 0) >= 0.9, 'stable live');
    expect(live.encoder?.frame).toBeGreaterThan(0);
    expect(live.encoder?.speed).toBeGreaterThanOrEqual(0.9);

    const stopResponse = await app.inject({ method: 'POST', url: `/api/pilot/sessions/${prepared.id}/stop` });
    expect(stopResponse.statusCode).toBe(200);
    await waitForSession(app, prepared.id, (session) => session.status === 'stopped', 'stopped');
  }, 15_000);

  it('keeps three independent 1080p30 sessions live and stops each one cleanly', async () => {
    const app = await createPilotApp();
    const ids: string[] = [];
    for (const [index, courtSlug] of ['pista-1', 'pista-2', 'pista-3'].entries()) {
      const response = await app.inject({
        method: 'POST', url: '/api/pilot/sessions', payload: {
          courtSlug, mode: 'simulation', sourceId: 'synthetic',
          homeTeam: `Local ${index + 1}`, awayTeam: `Visitante ${index + 1}`,
          matchdayNumber: 1, seasonLabel: 'T2',
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(), privacyStatus: 'private',
        },
      });
      expect(response.statusCode).toBe(201);
      ids.push(PilotSessionSchema.parse(response.json().session).id);
    }

    await Promise.all(ids.map((id) => app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/start` })));
    const live = await waitForSessions(app, ids, (session) =>
      session.status === 'live' && (session.encoder?.speed ?? 0) >= 0.9, 'three stable live sessions');
    expect(live).toHaveLength(3);

    await Promise.all(ids.map((id) => app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/stop` })));
    await waitForSessions(app, ids, (session) => session.status === 'stopped', 'three stopped sessions');
  }, 25_000);
});

async function createPilotApp() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kpl-pilot-'));
  const { app } = await buildApp({
    host: '127.0.0.1', port: 0, dataDir, webDistDir: join(dataDir, 'missing-web'), controlPin: null,
    pilot: {
      ffmpegPath: '/bin/ffmpeg',
      youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null },
    },
  });
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

async function waitForSession(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  id: string,
  matches: (session: ReturnType<typeof PilotSessionSchema.parse>) => boolean,
  expected: string,
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: '/api/pilot/sessions' });
    const session = (response.json().sessions as unknown[])
      .map((value) => PilotSessionSchema.parse(value))
      .find((candidate) => candidate.id === id);
    if (session !== undefined && matches(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pilot session did not reach ${expected}`);
}

async function waitForSessions(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  ids: readonly string[],
  matches: (session: ReturnType<typeof PilotSessionSchema.parse>) => boolean,
  expected: string,
) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: '/api/pilot/sessions' });
    const sessions = (response.json().sessions as unknown[])
      .map((value) => PilotSessionSchema.parse(value))
      .filter((session) => ids.includes(session.id));
    if (sessions.length === ids.length && sessions.every(matches)) return sessions;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Pilot sessions did not reach ${expected}`);
}
