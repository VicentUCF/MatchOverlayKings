import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
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
import { buildPilotMediaMtxConfiguration } from '../src/pilot-mobile-camera.js';
import type { PilotOverlayRenderer } from '../src/pilot-overlay.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('production pilot', () => {
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
    expect(preflight.headers['private-network-access-name']).toBe('kpl-production-agent');

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
      mobileCameraReadinessProbe: async () => undefined,
      mobileCameraVersionProbe: () => true,
      mobileCameraNow: () => now,
    });
    cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

    const readiness = PilotReadinessSchema.parse((await app.inject({ method: 'GET', url: '/api/pilot/readiness' })).json());
    expect(readiness.sources).toContainEqual({ id: 'mobile:pilot', kind: 'mobile', label: 'Móvil Android · WebRTC' });
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
    expect(claim.whipUrl).toBe('http://192.168.1.20:8889/mobile-pilot/whip');

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

    const revokedResponse = await app.inject({
      method: 'DELETE', url: `/api/pilot/mobile-camera/${created.session.id}`,
    });
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
    }, Buffer.alloc(32, 7));

    expect(configuration).toMatchObject({
      apiAddress: '127.0.0.1:9998',
      rtspAddress: '127.0.0.1:8554',
      rtspTransports: ['tcp'],
      webrtcAddress: ':8889',
      webrtcLocalUDPAddress: ':8189',
      webrtcAdditionalHosts: ['192.168.50.10'],
      paths: { 'mobile-pilot': { source: 'publisher', overridePublisher: false } },
    });
    expect(configuration.authInternalUsers[0]).toMatchObject({
      ips: ['127.0.0.1', '::1', '172.30.0.1'],
      permissions: [{ action: 'api' }, { action: 'read', path: 'mobile-pilot' }],
    });
    expect(configuration.authInternalUsers[1]).toMatchObject({
      user: 'camera', ips: ['192.168.50.0/24'], permissions: [{ action: 'publish', path: 'mobile-pilot' }],
    });
    expect(configuration.authInternalUsers[1]?.pass).toMatch(/^sha256:/);
  });
});

async function createPilotApp() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kpl-pilot-'));
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
      ffmpegPath: '/bin/ffmpeg',
      controlOrigins: ['https://live.kingspadelleague.es'],
      youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null },
    },
  }, { pilotOverlayRenderer: testOverlayRenderer() });
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
