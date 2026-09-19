import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PilotMobileCameraService } from '../src/pilot-mobile-camera.js';
import type { PilotMobileRuntimeEvent } from '../src/pilot-mobile-events.js';
import { PilotService } from '../src/pilot-service.js';
import { PilotYouTubeGateway } from '../src/pilot-youtube.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof ChildProcess>(), spawn: mocks.spawn }));
class MediaProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn((signal: string) => { this.signalCode = signal; this.emit('close', null); return true; });
  crash() { this.exitCode = 1; this.emit('close', 1); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  vi.useFakeTimers();
  const directory = await mkdtemp(join(tmpdir(), 'kpl-mobile-recovery-'));
  const processes: MediaProcess[] = [];
  const configurations: string[] = [];
  mocks.spawn.mockImplementation((_binary: string, args: string[]) => {
    const process = new MediaProcess();
    processes.push(process);
    configurations.push(args[0]!);
    return process;
  });
  const ready = vi.fn(async () => undefined);
  const mutation = vi.fn(async () => undefined);
  const health = vi.fn(async () => true);
  const events: PilotMobileRuntimeEvent[] = [];
  const createService = (available = true) => {
    const runtime = new PilotMobileCameraService({ mediaMtxPath: '/fake/mediamtx', lanHost: '192.168.1.20',
    lanCidr: '192.168.1.0/24', cameraPageOrigin: 'https://camera.example',
    webRtcPort: 18889, webRtcUdpPort: 18189, rtspPort: 18554, apiPort: 19998 }, directory, 4310,
  ready, () => available, () => Date.now(), mutation, health);
    runtime.observeRuntime((event) => events.push(event));
    return runtime;
  };
  const service = createService();
  await service.initialize();
  cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const links = await Promise.all([1, 2, 3].map((n) => service.create({ courtSlug: `pista-${n}` })));
  const link = links[0]!;
  const token = new URLSearchParams(new URL(link.connectUrl).hash.slice(1)).get('token')!;
  const clientId = '20000000-0000-4000-8000-000000000001';
  const claimed = await service.claim(link.session.id, token, { clientId, capabilities: {
    cameras: [{ id: 'rear', label: 'Trasera', facingMode: 'environment', maxWidth: 1920, maxHeight: 1080,
      maxFramesPerSecond: 30, supportedProfiles: ['720p30', '1080p30'] }], audioAvailable: true,
  } });
  const report = (revision: number) => service.report(link.session.id, token, { clientId, state: 'ready',
    applied: { revision, cameraId: 'rear', profile: '1080p30', audioEnabled: true, width: 1920, height: 1080, framesPerSecond: 30 },
    metrics: null, error: null });
  report(claimed.desired.revision);
  return { service, createService, directory, mutation, health, clientId, processes, configurations, links, link, token, ready, report, events, revision: claimed.desired.revision };
}

describe('MediaMTX recovery', () => {
  it('records startup configuration failures for all preserved cameras before enabling the control API', async () => {
    const f = await fixture(); await f.service.shutdown();
    const unavailable = f.createService(false); cleanups.push(() => unavailable.shutdown());
    const pilot = new PilotService('/missing/ffmpeg', new PilotYouTubeGateway({
      clientId: null, clientSecret: null, redirectUri: null, tokenPath: null,
    }), join(f.directory, 'configuration.json'), unavailable);
    await pilot.initialize(); cleanups.push(() => pilot.shutdown());
    await unavailable.initialize();
    await pilot.flushOperationalHistory();
    expect(pilot.incidentHistory()).toHaveLength(3);
    expect(pilot.incidentHistory().every(({ mobileRuntimeCode, severity, sessionId }) => mobileRuntimeCode === 'configuration_unavailable'
      && severity === 'critical' && sessionId === null)).toBe(true);
    expect(pilot.incidentHistory().map(({ courtSlug }) => courtSlug)).toEqual(['pista-1', 'pista-2', 'pista-3']);
    expect(f.processes).toHaveLength(1);
  });

  it('retains per-court incidents through a journal write failure and restart before any broadcast exists', async () => {
    const f = await fixture();
    const configurationPath = join(f.directory, 'configuration.json');
    const createPilot = () => new PilotService('/missing/ffmpeg', new PilotYouTubeGateway({
      clientId: null, clientSecret: null, redirectUri: null, tokenPath: null,
    }), configurationPath, f.service, undefined, {
      configure: async () => ({ homeTeamId: 'kings', awayTeamId: 'lions' }),
      assertConfigured: async () => ({ homeTeamId: 'kings', awayTeamId: 'lions' }),
    });
    const pilot = createPilot(); await pilot.initialize(); cleanups.push(() => pilot.shutdown());
    await pilot.configure('pista-1', { courtSlug: 'pista-1', mode: 'simulation', sourceId: 'mobile:pilot', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 4, seasonLabel: 'T2', scheduledAt: new Date().toISOString(), privacyStatus: 'private' });
    await pilot.flushOperationalHistory();
    const path = `${configurationPath}.operations`;
    const saved = await readFile(path, 'utf8');
    await rm(path); await mkdir(path);
    const occurredAt = new Date().toISOString();
    try {
      f.processes[0]!.crash();
      await expect(pilot.flushOperationalHistory()).rejects.toThrow();
      expect(pilot.readiness().limitations.join(' ')).toContain('historial');
    } finally { await rm(path, { recursive: true }); await writeFile(path, saved, { mode: 0o600 }); }
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(pilot.incidentHistory().filter(({ mobileRuntimeCode }) => mobileRuntimeCode === 'process_exit')).toHaveLength(3));
    await pilot.flushOperationalHistory();
    const incidents = pilot.incidentHistory().filter(({ category }) => category === 'mobile_runtime');
    expect(incidents.filter(({ mobileRuntimeCode }) => mobileRuntimeCode === 'process_exit').map(({ courtSlug }) => courtSlug).sort())
      .toEqual(['pista-1', 'pista-2', 'pista-3']);
    expect(incidents.find(({ courtSlug, mobileRuntimeCode }) => courtSlug === 'pista-1' && mobileRuntimeCode === 'process_exit'))
      .toMatchObject({ sessionId: null, status: null, mobileSessionId: f.link.session.id, createdAt: occurredAt,
        matchdayNumber: 4, seasonLabel: 'T2', operationId: pilot.operationHistory().at(-1)!.id });
    expect(incidents.find(({ courtSlug, mobileRuntimeCode }) => courtSlug === 'pista-2' && mobileRuntimeCode === 'process_exit'))
      .toMatchObject({ sessionId: null, matchdayNumber: null, seasonLabel: null, operationId: null });
    expect(incidents.filter(({ mobileRuntimeCode }) => mobileRuntimeCode === 'restored')).toHaveLength(3);
    expect(f.service.isReadyForCourt('pista-1')).toBe(false);
    expect(JSON.stringify(incidents)).not.toContain(f.token);
    expect(JSON.stringify(incidents)).not.toContain('tokenDigest');
    await pilot.shutdown();
    const restarted = createPilot(); await restarted.initialize(); cleanups.push(() => restarted.shutdown());
    expect(restarted.incidentHistory().filter(({ mobileRuntimeCode }) => mobileRuntimeCode === 'process_exit')).toHaveLength(3);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('detects an unresponsive living process and recovers within 30 seconds without browser polling', async () => {
    const f = await fixture();
    f.health.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.processes[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(f.processes[0]!.kill).toHaveBeenCalledWith('SIGINT'));
    expect(f.service.isReadyForCourt('pista-1')).toBe(false);
    await vi.waitFor(() => expect(f.service.limitation()).toContain('intento'));
    f.health.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(f.service.limitation()).toBeNull());
    expect(f.processes).toHaveLength(2);
    expect(f.service.current(f.link.session.id)?.desired.revision).toBe(f.revision + 1);
    expect(f.events.filter(({ code }) => code === 'unresponsive').map(({ courtSlug }) => courtSlug)).toEqual(['pista-1', 'pista-2', 'pista-3']);
    expect(f.events.filter(({ code }) => code === 'restored')).toHaveLength(3);
  });

  it('does not restart for isolated failed health checks', async () => {
    const f = await fixture();
    f.health.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.health).toHaveBeenCalledTimes(6);
    expect(f.processes).toHaveLength(1);
    expect(f.processes[0]!.kill).not.toHaveBeenCalled();
    expect(f.events.some(({ code }) => code === 'unresponsive')).toBe(false);
  });

  it('restores all court links, ownership, expiry and profiles after a server restart without exposing tokens', async () => {
    const f = await fixture();
    await f.service.updateDesired(f.link.session.id, { expectedRevision: f.revision, cameraId: 'rear', profile: '720p30', audioEnabled: false });
    await f.service.revoke(f.links[1]!.session.id);
    const before = f.service.current(f.link.session.id)!;
    await f.service.shutdown();
    const restarted = f.createService();
    cleanups.push(() => restarted.shutdown());
    await restarted.initialize();
    expect(restarted.list().map(({ id }) => id)).toEqual(f.links.map(({ session }) => session.id));
    expect(restarted.current(f.link.session.id)).toMatchObject({ claimed: true, state: 'reconnecting', expiresAt: before.expiresAt,
      desired: { profile: '720p30', audioEnabled: false } });
    expect(restarted.current(f.links[1]!.session.id)?.state).toBe('revoked');
    const capabilities = before.capabilities!;
    await expect(restarted.claim(f.link.session.id, f.token, { clientId: '20000000-0000-4000-8000-000000000099', capabilities })).rejects.toThrow('otro móvil');
    const claimed = await restarted.claim(f.link.session.id, f.token, { clientId: f.clientId, capabilities });
    expect(claimed.desired).toMatchObject({ cameraId: 'rear', profile: '720p30', audioEnabled: false });
    restarted.report(f.link.session.id, f.token, { clientId: f.clientId, state: 'ready', applied: null, metrics: null, error: null });
    expect(restarted.isReadyForCourt('pista-1')).toBe(false);
    restarted.report(f.link.session.id, f.token, { clientId: f.clientId, state: 'ready', applied: {
      ...claimed.desired, cameraId: 'rear', width: 1280, height: 720, framesPerSecond: 30,
    }, metrics: null, error: null });
    expect(restarted.isReadyForCourt('pista-1')).toBe(true);
    const disk = await readFile(join(f.directory, 'sessions.json'), 'utf8');
    expect(disk).not.toContain(f.token);
    expect(JSON.stringify(restarted.list())).not.toContain('tokenDigest');
    expect((await stat(join(f.directory, 'sessions.json'))).mode & 0o777).toBe(0o600);
    const restored = JSON.parse(await readFile(f.configurations.at(-1)!, 'utf8'));
    expect(Object.keys(restored.paths)).not.toContain(`mobile-pilot-${f.links[1]!.session.id}`);
  });

  it('does not reactivate expired links or start an empty runtime after a restart', async () => {
    const f = await fixture();
    await f.service.shutdown();
    vi.setSystemTime(Math.max(...f.links.map(({ session }) => Date.parse(session.expiresAt))) + 1);
    const restarted = f.createService();
    cleanups.push(() => restarted.shutdown());
    await restarted.initialize();
    expect(restarted.list().every(({ state }) => state === 'revoked')).toBe(true);
    expect(f.processes).toHaveLength(1);
    await expect(restarted.waitForDesired(f.link.session.id, f.token, 0)).rejects.toThrow('caducado');
  });

  it('keeps revocation durable when MediaMTX rejects live credential removal', async () => {
    const f = await fixture();
    f.mutation.mockRejectedValueOnce(new Error('unavailable'));
    await expect(f.service.revoke(f.link.session.id)).rejects.toThrow('revocado');
    expect(f.processes[0]!.kill).toHaveBeenCalled();
    await f.service.shutdown();
    const restarted = f.createService();
    cleanups.push(() => restarted.shutdown());
    await restarted.initialize();
    expect(restarted.current(f.link.session.id)?.state).toBe('revoked');
    await expect(restarted.waitForDesired(f.link.session.id, f.token, 0)).rejects.toThrow('caducado');
  });

  it('does not acknowledge profile changes if the durable snapshot cannot be written', async () => {
    const f = await fixture();
    const path = join(f.directory, 'sessions.json');
    const original = await readFile(path, 'utf8');
    await rm(path);
    await mkdir(path);
    try {
      await expect(f.service.updateDesired(f.link.session.id, { expectedRevision: f.revision, cameraId: 'rear', profile: '720p30', audioEnabled: false })).rejects.toThrow();
      expect(f.service.current(f.link.session.id)?.desired).toMatchObject({ revision: f.revision, profile: '1080p30' });
    } finally {
      await rm(path, { recursive: true });
      await writeFile(path, original, { mode: 0o600 });
    }
  });

  it('preserves a corrupt snapshot and refuses to start or overwrite it', async () => {
    const f = await fixture();
    await f.service.shutdown();
    const path = join(f.directory, 'sessions.json');
    await writeFile(path, '{broken');
    const restarted = f.createService();
    await expect(restarted.initialize()).rejects.toThrow('estado de las cámaras');
    await restarted.shutdown();
    expect(await readFile(path, 'utf8')).toBe('{broken');
    expect(f.processes).toHaveLength(1);
  });

  it('restarts one shared runtime with all original paths and credentials, rejecting stale ready reports', async () => {
    const f = await fixture();
    expect(f.service.isReadyForCourt('pista-1')).toBe(true);
    f.processes[0]!.crash();
    expect(f.service.current(f.link.session.id)?.state).toBe('reconnecting');
    f.report(f.revision);
    expect(f.service.isReadyForCourt('pista-1')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(2));
    const restored = JSON.parse(await readFile(f.configurations[1]!, 'utf8'));
    expect(Object.keys(restored.paths).sort()).toEqual(f.links.map(({ session }) => `mobile-pilot-${session.id}`).sort());
    expect(restored.authInternalUsers).toHaveLength(4);
    expect(JSON.stringify(restored)).not.toContain(f.token);
    expect(f.service.current(f.link.session.id)?.desired.revision).toBe(f.revision + 1);
    f.report(f.revision);
    expect(f.service.isReadyForCourt('pista-1')).toBe(false);
    f.report(f.revision + 1);
    expect(f.service.isReadyForCourt('pista-1')).toBe(true);
    expect(f.service.list().map(({ id }) => id)).toEqual(f.links.map(({ session }) => session.id));
  });

  it('stops after five brief failures, then permits explicit operator recovery with the same links', async () => {
    const f = await fixture();
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 15_000].entries()) {
      f.processes.at(-1)!.crash();
      await vi.advanceTimersByTimeAsync(delay);
      await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(index + 2));
    }
    f.processes.at(-1)!.crash();
    expect(f.events.filter(({ code }) => code === 'exhausted')).toHaveLength(3);
    expect(f.service.current(f.link.session.id)).toMatchObject({ state: 'error', error: expect.stringContaining('cinco reintentos') });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.processes).toHaveLength(6);
    await f.service.recoverRuntimeForCourt('pista-1');
    expect(f.events.filter(({ code }) => code === 'manual_recovery')).toHaveLength(3);
    expect(f.processes).toHaveLength(7);
    expect(f.service.current(f.link.session.id)?.state).toBe('reconnecting');
    expect(f.service.list()).toHaveLength(3);
  });

  it('bounds readiness failures and cancels queued recovery on shutdown', async () => {
    const f = await fixture();
    f.ready.mockRejectedValue(new Error('private credentials in upstream error'));
    f.processes[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(f.processes[1]?.kill).toHaveBeenCalled());
    expect(JSON.stringify(f.service.list())).not.toContain('private credentials');
    expect(JSON.stringify(f.events)).not.toContain('private credentials');
    const eventCount = f.events.length;
    await f.service.shutdown();
    expect(f.events).toHaveLength(eventCount);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.processes).toHaveLength(2);
  });
});
