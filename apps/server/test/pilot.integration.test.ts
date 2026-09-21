import { PilotService } from '../src/pilot-service.js';
import { passingPreflight } from './pilot-preflight-fixture.js';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderLiveScoreboardPng } from '@kpl/production-assets';
import {
  ClaimPilotMobileCameraResponseSchema,
  PilotConfigurationSchema,
  PilotMobileCameraLinkSchema,
  PilotMobileCameraSessionSchema,
  PilotReadinessSchema,
  PilotSessionSchema,
} from '@kpl/production-contracts';
import { buildApp } from '../src/app.js';
import { PilotServiceError } from '../src/pilot-service.js';
import type { ProductionAccessGuard } from '../src/production-access.js';
import { buildPilotMediaMtxConfiguration } from '../src/pilot-mobile-camera.js';
import type { PilotOverlayRenderer } from '../src/pilot-overlay.js';

const cleanups: Array<() => Promise<void>> = [];
const allowProductionAccess = { require: async () => undefined };

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('production pilot', () => {
  it('lets only the local production administrator browse real recording folders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-directory-api-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const app = await createPilotApp('/missing/ffmpeg', directory, { require: async (authorization, capability) => {
      if (authorization !== 'Bearer admin' || capability !== 'production_admin') {
        throw new PilotServiceError(403, 'FORBIDDEN', 'Acceso de administrador requerido.');
      }
    } });

    expect((await app.inject({ method: 'GET', url: '/api/pilot/recording-directories' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/pilot/recording-directories',
      headers: { authorization: 'Bearer admin' }, remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
    const response = await app.inject({ method: 'GET', url: '/api/pilot/recording-directories',
      headers: { authorization: 'Bearer admin' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ current: resolve(directory, 'recordings'), directories: [] });
  });

  it('records the composed program locally without YouTube and retains its path after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-recording-'));
    const recordingDirectory = join(directory, 'custom-recordings');
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const app = await createPilotApp('/bin/ffmpeg', directory);
    const response = await app.inject({ method: 'POST', url: '/api/pilot/sessions', payload: {
      courtSlug: 'pista-1', mode: 'recording', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', recordingDirectory,
      scheduledAt: new Date().toISOString(), privacyStatus: 'private',
    } });
    expect(response.statusCode).toBe(201);
    const { id } = response.json().session;
    const start = await app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/start` });
    expect(start.statusCode).toBe(200);
    const live = await waitForSession(app, id, (session) => session.status === 'live'
      && (session.encoder?.frame ?? 0) >= 60, 'recording');
    expect(live.broadcastId).toBeNull();
    expect(live.watchUrl).toBeNull();
    expect(live.recordingFiles).toHaveLength(1);
    await app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/stop` });
    await waitForSession(app, id, (session) => session.status === 'stopped', 'recording stopped');
    const path = live.recordingFiles![0]!;
    expect(path).toContain(join(recordingDirectory, 'pista-1', id));
    const probe = spawnSync('/bin/ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], { encoding: 'utf8' });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec_name: 'h264', width: 1920, height: 1080 }),
      expect.objectContaining({ codec_name: 'aac' }),
    ]));
    const decode = spawnSync('/bin/ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
    expect(decode.status, decode.stderr).toBe(0);
    await app.close();
    const restarted = await createPilotApp('/bin/ffmpeg', directory);
    const saved = await waitForSession(restarted, id, (session) => session.status === 'stopped', 'saved recording');
    expect(saved.recordingFiles).toEqual([path]);
  }, 20_000);

  it('protects program checks, cancellation and preview files with local administrator access', async () => {
    const app = await createPilotApp('/missing/ffmpeg', '', { require: async (authorization, capability) => {
      if (authorization !== 'Bearer admin' || capability !== 'production_admin') {
        throw new PilotServiceError(403, 'FORBIDDEN', 'Acceso de administrador requerido.');
      }
    } });
    const id = '11111111-1111-4111-8111-111111111111';
    for (const [method, suffix] of [['POST', 'preflight'], ['POST', 'preflight/cancel'], ['GET', `preflight-preview/${id}`]] as const) {
      const url = `/api/pilot/sessions/${id}/${suffix}`;
      expect((await app.inject({ method, url })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer admin' }, remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer operator' } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer admin' } })).statusCode).toBe(404);
    }
  });
  it('persists operation receipts and returns current state when preparation is retried after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-operation-restart-'));
    const app = await createPilotApp('/bin/ffmpeg', directory);
    const payload = {
      courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date().toISOString(), privacyStatus: 'private',
    };
    const headers = { 'idempotency-key': randomUUID() };
    const first = await app.inject({ method: 'POST', url: '/api/pilot/sessions', headers, payload });
    expect(first.statusCode).toBe(201);
    const id = first.json().session.id;
    const duplicate = await app.inject({ method: 'POST', url: '/api/pilot/sessions', headers, payload });
    expect(duplicate.json().session.id).toBe(id);
    await app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/stop` });
    await app.close();
    const restarted = await createPilotApp('/bin/ffmpeg', directory);
    const retried = await restarted.inject({ method: 'POST', url: '/api/pilot/sessions', headers, payload });
    expect(retried.statusCode).toBe(201);
    expect(retried.json().session).toMatchObject({ id, status: 'stopped' });
    const history = await restarted.inject({ method: 'GET', url: '/api/pilot/operations' });
    expect(history.statusCode).toBe(200);
    expect(history.json().operations).toHaveLength(2);
    expect(history.json().operations[0]).toMatchObject({ id: headers['idempotency-key'], kind: 'prepare', status: 'completed', sessionId: id });
    expect(JSON.stringify(history.json())).not.toContain('fingerprint');
    const incidents = await restarted.inject({ method: 'GET', url: '/api/pilot/incidents' });
    expect(incidents.statusCode).toBe(200);
    expect(incidents.json().incidents.map((incident: { status: string }) => incident.status))
      .toEqual(['prepared', 'stopping', 'stopped']);
  });

  it('recovers the same session on CPU when a GPU passes detection but fails during streaming', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-gpu-failure-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, 'ffmpeg');
    await writeFile(executable, `#!/usr/bin/env bash
case " $* " in
  *' -version '*) exec /bin/ffmpeg -version ;;
  *' -encoders '*) printf ' V..... h264_nvenc\\n'; exit 0 ;;
  *' -frames:v '*) exit 0 ;;
  *' h264_nvenc '*) printf '[h264_nvenc] OpenEncodeSessionEx failed\\n' >&2; exit 1 ;;
esac
exec /bin/ffmpeg "$@"
`, { mode: 0o700 });
    const app = await createPilotApp(executable, directory);
    const readiness = (await app.inject({ method: 'GET', url: '/api/pilot/readiness' })).json();
    expect(readiness.ffmpeg.encoders[0].name).toBe('h264_nvenc');
    const response = await app.inject({ method: 'POST', url: '/api/pilot/sessions', payload: {
      courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date().toISOString(), privacyStatus: 'private',
    } });
    expect(response.statusCode).toBe(201);
    const { id } = response.json().session;
    await app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/preflight`, payload: {} });
    const started = await app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/start` });
    expect(started.json().session.videoEncoding.name).toBe('h264_nvenc');
    const live = await waitForSession(app, id, (session) => session.status === 'live'
      && session.videoEncoding?.name === 'libx264' && (session.encoder?.frame ?? 0) > 0, 'CPU fallback');
    expect(live.encodingWarning).toContain('NVIDIA');
    expect((await app.inject({ method: 'GET', url: '/api/pilot/sessions' })).json().sessions).toHaveLength(1);
    await app.close();
    const restarted = await createPilotApp(executable, directory);
    const recovered = await restarted.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/recover` });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().session.videoEncoding.name).toBe('libx264');
    expect(recovered.json().session.encodingWarning).toContain('NVIDIA');
    await waitForSession(restarted, id, (session) => session.status === 'live', 'CPU after restart');
    await restarted.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/stop` });
    await waitForSession(restarted, id, (session) => session.status === 'stopped', 'stopped');
  }, 20_000);

  it('reports process liveness and FFmpeg readiness separately', async () => {
    const app = await createPilotApp();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, service: 'kpl-live-overlays' });

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      service: 'kpl-live-overlays',
      ffmpeg: { available: true },
    });
  });

  it('allows the configured production web origin to reach the loopback agent', async () => {
    const app = await createPilotApp();
    const origin = 'https://live.kingspadelleague.es';

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/pilot/readiness',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');
    expect(preflight.headers['private-network-access-name']).toBe('kpl-production-runtime');

    const teamsPreflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/teams',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });
    expect(teamsPreflight.statusCode).toBe(204);
    expect(teamsPreflight.headers['access-control-allow-origin']).toBe(origin);
    expect(teamsPreflight.headers['access-control-allow-private-network']).toBe('true');

    const allowed = await app.inject({ method: 'GET', url: '/api/pilot/readiness', headers: { origin } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);

    const teams = await app.inject({ method: 'GET', url: '/api/teams', headers: { origin } });
    expect(teams.statusCode).toBe(200);
    expect(teams.headers['access-control-allow-origin']).toBe(origin);

    const denied = await app.inject({
      method: 'GET', url: '/api/pilot/readiness', headers: { origin: 'https://attacker.example' },
    });
    expect(denied.statusCode).toBe(403);
  });

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
      description: 'Descripción común de todos los directos.',
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
    const relativeRecordingDirectory = await app.inject({
      method: 'PUT', url: '/api/pilot/configurations/pista-1',
      payload: { ...configurationPayload, recordingDirectory: 'grabaciones' },
    });
    expect(relativeRecordingDirectory.statusCode).toBe(400);
    expect(relativeRecordingDirectory.json().error.message).toContain('ruta absoluta');

    const preview = await app.inject({ method: 'POST', url: '/api/pilot/thumbnail-preview', payload: configurationPayload });
    expect(preview.statusCode).toBe(200);
    const changedPreview = await app.inject({ method: 'POST', url: '/api/pilot/thumbnail-preview',
      payload: { ...configurationPayload, matchdayNumber: 2 } });
    expect(changedPreview.json().dataUrl).not.toBe(preview.json().dataUrl);
    const invalidPreview = await app.inject({ method: 'POST', url: '/api/pilot/thumbnail-preview', payload: {} });
    expect(invalidPreview.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/pilot/sessions' })).json().sessions).toEqual([]);

    const prepareResponse = await app.inject({
      method: 'POST', url: '/api/pilot/sessions', payload: configurationPayload,
    });
    expect(prepareResponse.statusCode).toBe(201);
    const prepared = PilotSessionSchema.parse(prepareResponse.json().session);
    expect(prepared).toMatchObject({
      status: 'prepared', mode: 'simulation', broadcastId: null,
      description: 'Descripción común de todos los directos.',
    });

    const thumbnail = await app.inject({ method: 'GET', url: prepared.thumbnailUrl });
    expect(thumbnail.headers['content-type']).toContain('image/png');
    expect(preview.json().dataUrl).toBe(`data:image/png;base64,${thumbnail.rawPayload.toString('base64')}`);
    expect(thumbnail.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const checked = await app.inject({ method: 'POST', url: `/api/pilot/sessions/${prepared.id}/preflight`, payload: {} });
    expect(checked.statusCode).toBe(200);
    const clip = await app.inject({ method: 'GET', url: checked.json().session.preflight.preview.url });
    expect(clip.headers['cache-control']).toBe('no-store');
    expect(clip.headers['content-type']).toContain('video/mp4');
    expect(clip.body).toBe('LOCAL PREVIEW FIXTURE');
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

  it('explains that YouTube cannot prepare a broadcast scheduled in the past', async () => {
    const app = await createPilotApp();
    const response = await app.inject({
      method: 'POST', url: '/api/pilot/sessions', payload: {
        courtSlug: 'pista-1', mode: 'youtube', sourceId: 'synthetic',
        homeTeam: 'Red Lions', awayTeam: 'Kings', matchdayNumber: 1, seasonLabel: 'T2',
        scheduledAt: new Date(Date.now() - 60_000).toISOString(), privacyStatus: 'private',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_READY',
        message: 'Actualiza la fecha y hora: YouTube exige programar la emisión para un momento futuro.',
      },
    });
  });

  it('keeps three independent 1080p30 sessions live through a camera failure and stops each one cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-three-continuity-'));
    const app = await createPilotApp('/bin/ffmpeg', directory);
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

    await Promise.all(ids.map((id) => app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/preflight`, payload: {} })));
    await Promise.all(ids.map((id) => app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/start` })));
    const live = await waitForSessions(app, ids, (session) =>
      session.status === 'live' && (session.encoder?.speed ?? 0) >= 0.9, 'three stable live sessions');
    expect(live).toHaveLength(3);

    const processState = async () => JSON.parse(await readFile(join(directory, 'pilot-configurations.json.sessions'), 'utf8')) as {
      sessions: Array<{ public: { id: string }; runtimeProcess: { pid: number }; captureProcess: { pid: number } }>;
    };
    const before = await processState();
    const first = before.sessions.find(({ public: session }) => session.id === ids[0])!;
    expect(first.captureProcess.pid).not.toBe(first.runtimeProcess.pid);
    process.kill(first.captureProcess.pid, 'SIGKILL');
    const continuity = await waitForSession(app, ids[0]!, (session) => session.continuity?.active === true, 'continuity after capture failure');
    expect(continuity.status).toBe('live');
    const recovered = await waitForSessions(app, ids, (session) => session.status === 'live' && session.continuity?.active === false
      && (session.encoder?.frame ?? 0) > (live.find(({ id }) => id === session.id)?.encoder?.frame ?? 0) + 20, 'three progressing programs after recovery');
    expect(recovered).toHaveLength(3);
    const after = await processState();
    expect(after.sessions.map(({ runtimeProcess }) => runtimeProcess)).toEqual(before.sessions.map(({ runtimeProcess }) => runtimeProcess));
    expect(after.sessions.find(({ public: session }) => session.id === ids[0])!.captureProcess.pid).not.toBe(first.captureProcess.pid);

    await Promise.all(ids.map((id) => app.inject({ method: 'POST', url: `/api/pilot/sessions/${id}/stop` })));
    await waitForSessions(app, ids, (session) => session.status === 'stopped', 'three stopped sessions');
  }, 25_000);

  it('restores an interrupted session after a service restart and recovers the same session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kpl-pilot-recovery-'));
    await writeFile(join(dataDir, 'teams.json'), JSON.stringify([{
      id: 'kings-of-favar', name: 'Kings of Favar', shortName: 'Kings', logoUrl: '/logos/kings.png',
      primaryColor: '#D1007A', secondaryColor: '#0F1115',
    }]));
    const config = {
      host: '127.0.0.1', port: 0, dataDir, webDistDir: join(dataDir, 'missing-web'), controlPin: null,
      pilot: {
        ffmpegPath: '/bin/ffmpeg', controlOrigins: ['https://live.kingspadelleague.es'],
        youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null },
      },
    } as const;
    const dependencies = {
      pilotOverlayRenderer: testOverlayRenderer(), pilotPreflight: passingPreflight,
      productionAccessGuard: allowProductionAccess,
      pilotMatchBinding: {
        configure: async () => ({ homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }),
        assertConfigured: async () => ({ homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }),
      },
    };
    const first = await buildApp(config, dependencies);
    let second: Awaited<ReturnType<typeof buildApp>> | null = null;
    let firstClosed = false;
    cleanups.push(async () => {
      if (second !== null) await second.app.close();
      if (!firstClosed) await first.app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const payload = {
      courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic',
      homeTeam: 'Kings', awayTeam: 'Red Lions', matchdayNumber: 1, seasonLabel: 'T2',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(), privacyStatus: 'private',
    } as const;
    const preparedResponse = await first.app.inject({ method: 'POST', url: '/api/pilot/sessions', payload });
    const prepared = PilotSessionSchema.parse(preparedResponse.json().session);
    await first.app.inject({ method: 'POST', url: `/api/pilot/sessions/${prepared.id}/preflight`, payload: {} });
    await first.app.inject({ method: 'POST', url: `/api/pilot/sessions/${prepared.id}/start` });
    await waitForSession(first.app, prepared.id, (session) => session.status === 'live', 'live before restart');
    await first.app.close();
    firstClosed = true;

    second = await buildApp(config, dependencies);
    const restored = PilotSessionSchema.parse((await second.app.inject({
      method: 'GET', url: '/api/pilot/sessions',
    })).json().sessions[0]);
    expect(restored).toMatchObject({ id: prepared.id, status: 'interrupted', broadcastId: null });
    expect(restored.error).toContain('servicio se reinició');
    expect((await second.app.inject({
      method: 'GET', url: `/api/pilot/sessions/${prepared.id}/thumbnail`,
    })).statusCode).toBe(200);

    const recoveredResponse = await second.app.inject({
      method: 'POST', url: `/api/pilot/sessions/${prepared.id}/recover`,
    });
    expect(recoveredResponse.statusCode).toBe(200);
    expect(PilotSessionSchema.parse(recoveredResponse.json().session).id).toBe(prepared.id);
    await waitForSession(second.app, prepared.id, (session) => session.status === 'live', 'live after recovery');
    await second.app.inject({ method: 'POST', url: `/api/pilot/sessions/${prepared.id}/stop` });
    await waitForSession(second.app, prepared.id, (session) => session.status === 'stopped', 'stopped after recovery');
  }, 25_000);

  it('pairs one authenticated Android client and revokes its secret without exposing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kpl-pilot-mobile-'));
    const mediaMtxPath = join(dataDir, 'fake-mediamtx.mjs');
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    await writeFile(mediaMtxPath, fakeMediaMtxSource(), { mode: 0o700 });
    await chmod(mediaMtxPath, 0o700);
    const { app } = await buildApp({
      host: '127.0.0.1', port: 4310, dataDir, webDistDir: join(dataDir, 'missing-web'), controlPin: null,
      pilot: {
        ffmpegPath: '/bin/ffmpeg',
        youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null },
        mobileCamera: {
          mediaMtxPath, lanHost: '192.168.1.20', lanCidr: '192.168.1.0/24',
          cameraPageOrigin: 'https://live.kingspadelleague.es',
          webRtcPort: 8889, webRtcUdpPort: 8189, rtspPort: 8554, apiPort: 9998,
        },
      },
    }, {
      mobileCameraHealthProbe: async () => true,
      mobileCameraReadinessProbe: async () => undefined,
      mobileCameraVersionProbe: () => true,
      mobileCameraNow: () => now,
      mobileCameraApiMutation: async () => undefined,
      productionAccessGuard: allowProductionAccess,
    });
    cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

    const readiness = PilotReadinessSchema.parse((await app.inject({ method: 'GET', url: '/api/pilot/readiness' })).json());
    expect(readiness.sources).toContainEqual({ id: 'mobile:pilot', kind: 'mobile', label: 'Puerta de enlace · WebRTC' });
    const remoteAdmin = await app.inject({
      method: 'GET', url: '/api/pilot/mobile-camera', remoteAddress: '192.168.1.45',
    });
    expect(remoteAdmin.statusCode).toBe(403);

    const createdResponse = await app.inject({
      method: 'POST', url: '/api/pilot/mobile-camera', payload: { courtSlug: 'pista-2' },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = PilotMobileCameraLinkSchema.parse(createdResponse.json());
    const connectUrl = new URL(created.connectUrl);
    const fragment = new URLSearchParams(connectUrl.hash.slice(1));
    const token = fragment.get('token');
    expect(token).toHaveLength(43);
    expect(connectUrl.search).toBe('');
    expect(connectUrl.pathname).toBe('/camera/pilot');
    expect(JSON.stringify(created.session)).not.toContain(token);

    const clientId = '20000000-0000-4000-8000-000000000001';
    const claimPayload = {
      clientId,
      capabilities: {
        cameras: [{
          id: 'rear', label: 'Cámara trasera', facingMode: 'environment', maxWidth: 1920, maxHeight: 1080,
          maxFramesPerSecond: 60, supportedProfiles: ['720p30', '720p60', '1080p30', '1080p60'],
        }],
        audioAvailable: true,
      },
    } as const;
    const mobileHeaders = { origin: 'https://live.kingspadelleague.es', authorization: `Bearer ${token}` };
    const preflight = await app.inject({
      method: 'OPTIONS', url: `/api/pilot/mobile-camera/${created.session.id}/claim`,
      headers: { origin: mobileHeaders.origin, 'access-control-request-private-network': 'true' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');

    const desiredPreflight = await app.inject({
      method: 'OPTIONS', url: `/api/pilot/mobile-camera/${created.session.id}/desired`,
      headers: {
        origin: mobileHeaders.origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
        'access-control-request-private-network': 'true',
      },
    });
    expect(desiredPreflight.statusCode).toBe(204);
    expect(desiredPreflight.headers['access-control-allow-methods']).toContain('PUT');
    expect(desiredPreflight.headers['access-control-allow-private-network']).toBe('true');

    const claimResponse = await app.inject({
      method: 'POST', url: `/api/pilot/mobile-camera/${created.session.id}/claim`, headers: mobileHeaders,
      payload: claimPayload,
    });
    expect(claimResponse.statusCode).toBe(200);
    const claim = ClaimPilotMobileCameraResponseSchema.parse(claimResponse.json());
    expect(claim.desired).toMatchObject({ cameraId: 'rear', profile: '1080p30', audioEnabled: true });
    expect(claim.whipUrl).toBe(`http://192.168.1.20:8889/mobile-pilot-${created.session.id}/whip`);

    const secondClaim = await app.inject({
      method: 'POST', url: `/api/pilot/mobile-camera/${created.session.id}/claim`, headers: mobileHeaders,
      payload: { ...claimPayload, clientId: '30000000-0000-4000-8000-000000000001' },
    });
    expect(secondClaim.statusCode).toBe(409);
    const wrongOrigin = await app.inject({
      method: 'POST', url: `/api/pilot/mobile-camera/${created.session.id}/claim`,
      headers: { ...mobileHeaders, origin: 'https://attacker.example' }, payload: claimPayload,
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const firstUpdate = await app.inject({
      method: 'PUT', url: `/api/pilot/mobile-camera/${created.session.id}/desired`,
      payload: { expectedRevision: claim.desired.revision, cameraId: 'rear', profile: '720p60', audioEnabled: false },
    });
    expect(firstUpdate.statusCode).toBe(200);
    const updated = PilotMobileCameraSessionSchema.parse(firstUpdate.json().mobileCamera);
    expect(updated.desired).toMatchObject({ revision: claim.desired.revision + 1, profile: '720p60', audioEnabled: false });
    const staleUpdate = await app.inject({
      method: 'PUT', url: `/api/pilot/mobile-camera/${created.session.id}/desired`,
      payload: { expectedRevision: claim.desired.revision, cameraId: 'rear', profile: '720p30', audioEnabled: false },
    });
    expect(staleUpdate.statusCode).toBe(409);

    const statusResponse = await app.inject({
      method: 'POST', url: `/api/pilot/mobile-camera/${created.session.id}/status`, headers: mobileHeaders,
      payload: {
        clientId, state: 'ready', error: null,
        applied: {
          revision: updated.desired.revision, cameraId: 'rear', profile: '720p60', audioEnabled: false,
          width: 1280, height: 720, framesPerSecond: 59.8,
        },
        metrics: { bitrateKbps: 8100, packetLossPercent: 0.4, roundTripTimeMs: 28 },
      },
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(PilotMobileCameraSessionSchema.parse(statusResponse.json().mobileCamera).state).toBe('ready');

    let degradedState = PilotMobileCameraSessionSchema.parse(statusResponse.json().mobileCamera);
    for (let sample = 0; sample < 3; sample += 1) {
      const degraded = await app.inject({
        method: 'POST', url: `/api/pilot/mobile-camera/${created.session.id}/status`, headers: mobileHeaders,
        payload: {
          clientId, state: 'ready', error: null,
          applied: {
            revision: updated.desired.revision, cameraId: 'rear', profile: '720p60', audioEnabled: false,
            width: 1280, height: 720, framesPerSecond: 40,
          },
          metrics: { bitrateKbps: 4000, packetLossPercent: 6, roundTripTimeMs: 600 },
        },
      });
      degradedState = PilotMobileCameraSessionSchema.parse(degraded.json().mobileCamera);
    }
    expect(degradedState.state).toBe('degraded');
    now += 6_001;
    const reconnecting = PilotMobileCameraSessionSchema.parse((await app.inject({
      method: 'GET', url: '/api/pilot/mobile-camera',
    })).json().mobileCamera);
    expect(reconnecting.state).toBe('reconnecting');
    now += 14_000;
    const offline = PilotMobileCameraSessionSchema.parse((await app.inject({
      method: 'GET', url: '/api/pilot/mobile-camera',
    })).json().mobileCamera);
    expect(offline.state).toBe('offline');

    const activeCourt = vi.spyOn(PilotService.prototype, 'isCourtActive').mockReturnValue(true);
    const revokedResponse = await app.inject({
      method: 'DELETE', url: `/api/pilot/mobile-camera/${created.session.id}`,
    });
    expect(revokedResponse.statusCode).toBe(200);
    activeCourt.mockRestore();
    expect(PilotMobileCameraSessionSchema.parse(revokedResponse.json().mobileCamera).state).toBe('revoked');
    const reused = await app.inject({
      method: 'POST', url: `/api/pilot/mobile-camera/${created.session.id}/claim`, headers: mobileHeaders,
      payload: claimPayload,
    });
    expect(reused.statusCode).toBe(410);

    const replacementResponse = await app.inject({
      method: 'POST', url: '/api/pilot/mobile-camera', payload: { courtSlug: 'pista-1' },
    });
    const replacement = PilotMobileCameraLinkSchema.parse(replacementResponse.json());
    const replacementToken = new URLSearchParams(new URL(replacement.connectUrl).hash.slice(1)).get('token');
    expect(Date.parse(replacement.session.expiresAt) - now).toBe(12 * 60 * 60_000);
    now += 12 * 60 * 60_000 + 1;
    const expired = await app.inject({
      method: 'POST', url: `/api/pilot/mobile-camera/${replacement.session.id}/claim`,
      headers: { origin: mobileHeaders.origin, authorization: `Bearer ${replacementToken}` }, payload: claimPayload,
    });
    expect(expired.statusCode).toBe(410);
  });

  it('lists three mobile cameras and prepares an independent broadcast for each court', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kpl-multi-mobile-'));
    const mediaMtxPath = join(dataDir, 'mediamtx');
    await writeFile(mediaMtxPath, fakeMediaMtxSource(), { mode: 0o700 });
    const { app } = await buildApp({
      host: '127.0.0.1', port: 4310, dataDir, webDistDir: join(dataDir, 'missing-web'), controlPin: null,
      pilot: {
        ffmpegPath: '/bin/ffmpeg',
        youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null },
        mobileCamera: { mediaMtxPath, lanHost: '192.168.1.20', lanCidr: '192.168.1.0/24',
          cameraPageOrigin: 'https://live.kingspadelleague.es',
          webRtcPort: 8889, webRtcUdpPort: 8189, rtspPort: 8554, apiPort: 9998 },
      },
    }, {
      mobileCameraHealthProbe: async () => true,
      mobileCameraReadinessProbe: async () => undefined, mobileCameraVersionProbe: () => true,
      mobileCameraApiMutation: async () => undefined, productionAccessGuard: allowProductionAccess,
      pilotOverlayRenderer: testOverlayRenderer(), pilotPreflight: passingPreflight, pilotMatchBinding: {
        configure: async () => ({ homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }),
        assertConfigured: async () => ({ homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }),
      },
    });
    cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    const links = await Promise.all([1, 2, 3].map(async (number) => {
      const response = await app.inject({ method: 'POST', url: '/api/pilot/mobile-camera', payload: { courtSlug: `pista-${number}` } });
      expect(response.statusCode).toBe(201);
      return PilotMobileCameraLinkSchema.parse(response.json());
    }));
    expect((await app.inject({ method: 'GET', url: '/api/pilot/mobile-cameras', remoteAddress: '192.168.1.40' })).statusCode).toBe(403);
    const listed = (await app.inject({ method: 'GET', url: '/api/pilot/mobile-cameras' })).json().mobileCameras;
    expect(listed.map((session: { courtSlug: string }) => session.courtSlug).sort()).toEqual(['pista-1', 'pista-2', 'pista-3']);
    for (const link of links) {
      const token = new URLSearchParams(new URL(link.connectUrl).hash.slice(1)).get('token');
      const headers = { origin: 'https://live.kingspadelleague.es', authorization: `Bearer ${token}` };
      const clientId = link.session.id;
      const claim = await app.inject({ method: 'POST', url: `/api/pilot/mobile-camera/${link.session.id}/claim`, headers,
        payload: { clientId, capabilities: { cameras: [{ id: 'rear', label: 'Trasera', facingMode: 'environment',
          maxWidth: 1280, maxHeight: 720, maxFramesPerSecond: 30, supportedProfiles: ['720p30'] }], audioAvailable: false } },
      });
      expect(claim.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/pilot/mobile-camera/${link.session.id}/status`, headers,
        payload: { clientId, state: 'ready', applied: { revision: claim.json().desired.revision,
          cameraId: 'rear', profile: '720p30', audioEnabled: false, width: 1280, height: 720, framesPerSecond: 30 }, metrics: null, error: null },
      })).statusCode).toBe(200);
      const prepared = await app.inject({ method: 'POST', url: '/api/pilot/sessions', payload: {
        courtSlug: link.session.courtSlug, mode: 'simulation', sourceId: 'mobile:pilot',
        homeTeam: 'Kings', awayTeam: 'Lions', matchdayNumber: 1, seasonLabel: 'T2',
        scheduledAt: new Date().toISOString(), privacyStatus: 'private',
      } });
      expect(prepared.statusCode).toBe(201);
    }
    expect((await app.inject({ method: 'GET', url: '/api/pilot/sessions' })).json().sessions).toHaveLength(3);
    expect((await app.inject({ method: 'POST', url: '/api/pilot/mobile-camera', payload: { courtSlug: 'pista-1' } })).statusCode).toBe(409);
  }, 15_000);

  it('keeps mobile disabled when MediaMTX or LAN settings are absent', async () => {
    const app = await createPilotApp();
    const readiness = PilotReadinessSchema.parse((await app.inject({ method: 'GET', url: '/api/pilot/readiness' })).json());
    expect(readiness.sources.some(({ kind }) => kind === 'mobile')).toBe(false);
    const response = await app.inject({
      method: 'POST', url: '/api/pilot/mobile-camera', payload: { courtSlug: 'pista-1' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('binds MediaMTX control protocols to loopback and WebRTC to the configured LAN ports', () => {
    const configuration = buildPilotMediaMtxConfiguration({
      mediaMtxPath: '/opt/mediamtx', lanHost: '192.168.50.10', lanCidr: '192.168.50.0/24',
      adminHost: '172.30.0.1',
      cameraPageOrigin: 'https://live.kingspadelleague.es',
      webRtcPort: 8889, webRtcUdpPort: 8189, rtspPort: 8554, apiPort: 9998,
    }, [{ id: 'first', tokenDigest: Buffer.alloc(32, 7) }, { id: 'second', tokenDigest: Buffer.alloc(32, 8) }]);

    expect(configuration).toMatchObject({
      apiAddress: '127.0.0.1:9998',
      rtspAddress: '127.0.0.1:8554',
      rtspTransports: ['tcp'],
      webrtcAddress: ':8889',
      webrtcLocalUDPAddress: ':8189',
      webrtcAdditionalHosts: ['192.168.50.10'],
      paths: {
        'mobile-pilot-first': { source: 'publisher', overridePublisher: false },
        'mobile-pilot-second': { source: 'publisher', overridePublisher: false },
      },
    });
    expect(configuration.authInternalUsers[0]).toMatchObject({
      ips: ['127.0.0.1', '::1', '172.30.0.1'],
      permissions: [{ action: 'api' }, { action: 'read', path: 'mobile-pilot-first' }, { action: 'read', path: 'mobile-pilot-second' }],
    });
    expect(configuration.authInternalUsers[1]).toMatchObject({
      user: 'camera-first', ips: ['192.168.50.0/24'], permissions: [{ action: 'publish', path: 'mobile-pilot-first' }],
    });
    expect(configuration.authInternalUsers[1]?.pass).toMatch(/^sha256:/);
    expect(configuration.authInternalUsers[2]).toMatchObject({
      user: 'camera-second', ips: ['192.168.50.0/24'], permissions: [{ action: 'publish', path: 'mobile-pilot-second' }],
    });
  });
});

async function createPilotApp(ffmpegPath = '/bin/ffmpeg', dataDir = '', access: ProductionAccessGuard = allowProductionAccess) {
  if (!dataDir) dataDir = await mkdtemp(join(tmpdir(), 'kpl-pilot-'));
  await writeFile(join(dataDir, 'teams.json'), JSON.stringify([{
    id: 'kings-of-favar',
    name: 'Kings of Favar',
    shortName: 'Kings',
    logoUrl: '/logos/kings.png',
    primaryColor: '#D1007A',
    secondaryColor: '#0F1115',
  }]));
  const { app } = await buildApp({
    host: '127.0.0.1', port: 0, dataDir, webDistDir: join(dataDir, 'missing-web'), controlPin: null,
    pilot: {
      ffmpegPath,
      controlOrigins: ['https://live.kingspadelleague.es'],
      youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null },
    },
  }, { pilotOverlayRenderer: testOverlayRenderer(), pilotPreflight: passingPreflight, productionAccessGuard: access, pilotMatchBinding: {
    configure: async () => ({ homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }),
    assertConfigured: async () => ({ homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }),
  } });
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

function testOverlayRenderer(): PilotOverlayRenderer {
  const frame = renderLiveScoreboardPng({
    width: 1920,
    height: 1080,
    title: '',
    courtName: '',
    homeName: '',
    awayName: '',
    homeSets: [],
    awaySets: [],
    homePoint: '0',
    awayPoint: '0',
    servingSide: 'home',
    visible: false,
  });
  return {
    close: async () => undefined,
    start: async (output: Writable, options, signal) => {
      output.on('error', () => undefined);
      const intervalMs = 1_000 / options.framesPerSecond;
      try {
        while (!signal.aborted && !output.destroyed) {
          output.write(frame);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ECONNRESET')) throw error;
      }
      if (!output.destroyed) output.end();
    },
  };
}

async function waitForSession(
  app: Awaited<Awaited<ReturnType<typeof buildApp>>['app']>,
  id: string,
  matches: (session: ReturnType<typeof PilotSessionSchema.parse>) => boolean,
  expected: string,
) {
  const deadline = Date.now() + 8_000;
  let observed: unknown = null;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: '/api/pilot/sessions' });
    const session = (response.json().sessions as unknown[])
      .map((value) => PilotSessionSchema.parse(value))
      .find((candidate) => candidate.id === id);
    observed = session && { status: session.status, videoEncoding: session.videoEncoding, encoder: session.encoder, continuity: session.continuity, error: session.error };
    if (session !== undefined && matches(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pilot session did not reach ${expected}: ${JSON.stringify(observed)}`);
}

async function waitForSessions(
  app: Awaited<Awaited<ReturnType<typeof buildApp>>['app']>,
  ids: readonly string[],
  matches: (session: ReturnType<typeof PilotSessionSchema.parse>) => boolean,
  expected: string,
) {
  const deadline = Date.now() + 12_000;
  let diagnostics = '';
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: '/api/pilot/sessions' });
    const sessions = (response.json().sessions as unknown[])
      .map((value) => PilotSessionSchema.parse(value))
      .filter((session) => ids.includes(session.id));
    diagnostics = JSON.stringify(sessions.map(({ courtSlug, status, encoder, error }) => ({ courtSlug, status, encoder, error })));
    if (sessions.length === ids.length && sessions.every(matches)) return sessions;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Pilot sessions did not reach ${expected}: ${diagnostics}`);
}

function fakeMediaMtxSource(): string {
  return `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('v1.21.0\\n');
  process.exit(0);
}
const keepAlive = setInterval(() => undefined, 1000);
process.on('SIGINT', () => { clearInterval(keepAlive); process.exit(0); });
`;
}
