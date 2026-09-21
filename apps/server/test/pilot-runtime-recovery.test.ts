import { passingPreflight } from './pilot-preflight-fixture.js';
import { EventEmitter } from 'node:events';
import type * as ChildProcess from 'node:child_process';
import type * as VideoEncoders from '../src/pilot-video-encoder.js';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PilotService, type PilotPreflightDependencies } from '../src/pilot-service.js';
import { PilotYouTubeGateway } from '../src/pilot-youtube.js';
import { YouTubePreparationSchema } from '../src/pilot-youtube-preparation.js';
import type { ProgramFeedOptions } from '../src/pilot-program-feed.js';
import type { PilotOverlayOptions } from '../src/pilot-overlay.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof ChildProcess>(),
  spawn: mocks.spawn,
  spawnSync: () => ({ status: 0, stdout: 'ffmpeg test\n' }),
}));
vi.mock('../src/pilot-video-encoder.js', async (original) => {
  const actual = await original<typeof VideoEncoders>();
  return { ...actual, detectVideoEncoders: async () => [actual.CPU_ENCODER] };
});

class FakeEncoder extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdio = [null, this.stdout, this.stderr, new PassThrough(), new PassThrough(), new PassThrough()];
  kill = vi.fn(() => { this.emit('close', null); return true; });
  progress(frame: number) { this.stdout.write(`frame=${frame}\nfps=30\nspeed=1.0x\nprogress=continue\n`); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(mode: 'simulation' | 'youtube' = 'simulation', checked = true, preflight: PilotPreflightDependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-runtime-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const encoders: FakeEncoder[] = [];
  mocks.spawn.mockImplementation(() => { const child = new FakeEncoder(); encoders.push(child); return child; });
  const youtube = new PilotYouTubeGateway({ clientId: null, clientSecret: null, redirectUri: null, tokenPath: null });
  vi.spyOn(youtube, 'configured', 'get').mockReturnValue(true);
  vi.spyOn(youtube, 'isAuthorized', 'get').mockReturnValue(true);
  vi.spyOn(youtube, 'prepareBroadcast').mockResolvedValue({ broadcastId: 'broadcast', streamId: 'stream', ingestUrl: 'rtmps://example.test/secret', watchUrl: 'https://youtube.com/watch?v=broadcast' });
  const health = vi.spyOn(youtube, 'health').mockResolvedValue({ broadcastStatus: 'live', streamStatus: 'active', healthStatus: 'good' });
  const complete = vi.spyOn(youtube, 'completeBroadcast').mockResolvedValue();
  const binding = { configure: async () => ({ homeTeamId: 'kings', awayTeamId: 'lions' }),
    assertConfigured: async () => ({ homeTeamId: 'kings', awayTeamId: 'lions' }) };
  const sources: ProgramFeedOptions[] = [];
  const overlays: PilotOverlayOptions[] = [];
  const recoverCapture = vi.fn();
  const recoverOverlay = vi.fn(async () => {
    overlays.at(-1)?.onState?.({ status: 'ready', attempt: 0, lastFrameAt: new Date().toISOString(), holdingLastFrame: false, reason: null });
  });
  const createService = () => new PilotService('/fake/ffmpeg', youtube, join(directory, 'configuration.json'), undefined,
    { start: async (_output, options) => { overlays.push(options); }, recover: recoverOverlay, close: async () => undefined }, binding, undefined, (options) => {
      sources.push(options);
      return { captureProcess: null, start: async () => { options.onState({ active: false, attempt: 0, exhausted: false, reason: null }); },
        close: async () => undefined, recover: async () => { recoverCapture(); options.onState({ active: false, attempt: 0, exhausted: false, reason: null }); } };
    }, Object.keys(preflight).length ? { ...passingPreflight, ...preflight } : passingPreflight);
  const service = createService();
  await service.initialize();
  cleanups.push(() => service.shutdown());
  const session = await service.prepare({
    courtSlug: 'pista-1', mode, sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
    matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), privacyStatus: 'private',
  });
  if (checked) await service.preflight(session.id, {});
  return { directory, service, session, encoders, health, complete, binding, youtube, createService, sources, overlays, recoverCapture, recoverOverlay };
}

describe('production runtime recovery', () => {
  it('restores legacy sessions from court settings and persists them across another restart', async () => {
    const { directory, service, session, createService } = await fixture('simulation', false);
    await service.shutdown();
    const path = join(directory, 'configuration.json.sessions');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const configuration = saved.sessions[0].configuration;
    await writeFile(join(directory, 'configuration.json'), JSON.stringify([
      { ...configuration, updatedAt: new Date().toISOString() },
    ]));
    delete saved.sessions[0].configuration;
    await writeFile(path, JSON.stringify(saved));

    const restarted = createService();
    await restarted.initialize();
    cleanups.push(() => restarted.shutdown());
    const migratedConfiguration = {
      ...configuration,
      mode: 'recording',
      scheduledAt: expect.any(String),
      recordingDirectory: join(directory, 'recordings'),
    };
    expect(restarted.get(session.id).configuration).toEqual(migratedConfiguration);
    expect(restarted.configurations()[0]).toHaveProperty('updatedAt');
    await restarted.shutdown();
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.sessions[0].configuration).toEqual(migratedConfiguration);

    const again = createService();
    await again.initialize();
    cleanups.push(() => again.shutdown());
    expect(again.get(session.id).configuration).toEqual(migratedConfiguration);
  });

  it('reports insufficient combined capacity without preventing either court from starting', async () => {
    const upload = vi.fn(async () => ({ kbps: 15_000, checkedAt: new Date().toISOString(), bytes: 2 * 1024 ** 2 }));
    const { service, session } = await fixture('youtube', true, { upload });
    const second = await service.prepare({ courtSlug: 'pista-2', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), privacyStatus: 'private' });
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(service.get(session.id).public.preflight?.status).toBe('stale');
    const checked = await service.preflight(second.id, {});
    expect(checked.preflight?.checks.find(({ id }) => id === 'network')).toMatchObject({ status: 'blocked' });
    expect(checked.preflight?.checks.find(({ id }) => id === 'network')?.message).toContain('15.9 Mbps');
    await expect(service.start(second.id)).resolves.toMatchObject({ status: 'starting' });
    expect(upload).toHaveBeenCalledOnce();
  });

  it('does not measure upload on an active output when the cached measurement expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const upload = vi.fn(passingPreflight.upload!);
    const { service, session } = await fixture('youtube', true, { upload });
    await service.start(session.id);
    vi.setSystemTime(Date.now() + 300_001);
    const second = await service.prepare({ courtSlug: 'pista-2', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), privacyStatus: 'private' });
    const checked = await service.preflight(second.id, {});
    expect(checked.preflight?.checks.find(({ id }) => id === 'network')).toMatchObject({ status: 'warning' });
    expect(upload).toHaveBeenCalledOnce();
  });

  it('invalidates other court reports when a repeated upload reveals lower capacity', async () => {
    const upload = vi.fn(passingPreflight.upload!);
    const { service, session } = await fixture('youtube', false, { upload });
    const second = await service.prepare({ courtSlug: 'pista-2', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), privacyStatus: 'private' });
    await service.preflight(session.id, {}); await service.preflight(second.id, {});
    upload.mockResolvedValueOnce({ kbps: 1_000, checkedAt: new Date().toISOString(), bytes: 2 * 1024 ** 2 });
    const checked = await service.preflight(second.id, { check: 'network' });
    expect(checked.preflight?.status).toBe('blocked');
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(service.get(session.id).public.preflight?.status).toBe('stale');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('aborts an ongoing upload as soon as another checked court starts its output', async () => {
    let measuring: AbortSignal | undefined;
    const upload = vi.fn(passingPreflight.upload!).mockImplementationOnce(passingPreflight.upload!);
    const { service, session } = await fixture('youtube', false, { upload });
    const second = await service.prepare({ courtSlug: 'pista-2', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), privacyStatus: 'private' });
    await service.preflight(session.id, {}); await service.preflight(second.id, {});
    upload.mockImplementationOnce(async (signal) => {
      measuring = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Output started')), { once: true }));
    });
    const checking = service.preflight(second.id, { check: 'network' });
    await vi.waitFor(() => expect(measuring).toBeDefined());
    await service.start(session.id);
    expect(measuring?.aborted).toBe(true);
    expect((await checking).preflight?.checks.find(({ id }) => id === 'network')?.status).toBe('warning');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('starts without running optional diagnostics', async () => {
    const host = vi.fn(passingPreflight.host!);
    const media = vi.fn(passingPreflight.media!);
    const { service, session, encoders } = await fixture('youtube', false, { host, media });
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(encoders).toHaveLength(1);
    expect(host).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
  });

  it('keeps optional previews protected and permits starting with stale diagnostics after restart', async () => {
    const { service, session, encoders, createService } = await fixture('simulation', false);
    const checked = await service.preflight(session.id, {});
    expect(checked.preflight?.status).toBe('warning');
    expect(checked.preflight?.checks).toHaveLength(14);
    const runId = checked.preflight!.preview!.url.split('/').at(-1)!;
    expect((await service.preflightPreview(session.id, runId)).toString()).toBe('LOCAL PREVIEW FIXTURE');
    await expect(service.preflightPreview(session.id, '../outside')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await service.shutdown();
    const restarted = createService(); await restarted.initialize(); cleanups.push(() => restarted.shutdown());
    expect(restarted.get(session.id).public.preflight?.status).toBe('stale');
    await expect(restarted.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(encoders).toHaveLength(1);
  });

  it('expires diagnostics when the encoder context changes without vetoing a start', async () => {
    const { service, session, encoders } = await fixture();
    service.get(session.id).rejectedEncoders.add('changed');
    await service.list();
    expect(service.get(session.id).public.preflight?.status).toBe('stale');
    await service.preflight(session.id, {});
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await expect(service.preflight(session.id, { check: 'storage' })).rejects.toMatchObject({ code: 'NOT_READY' });
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(encoders).toHaveLength(1);
  });

  it('retries a failed metadata check without recapturing a valid program', async () => {
    const { service, session } = await fixture('simulation', false);
    const transport = vi.spyOn(passingPreflight, 'host').mockRejectedValueOnce(new Error('storage unavailable'));
    const media = vi.spyOn(passingPreflight, 'media');
    const blocked = await service.preflight(session.id, {});
    expect(blocked.preflight?.status).toBe('blocked');
    expect(media).not.toHaveBeenCalled();
    transport.mockRestore();
    await service.preflight(session.id, {});
    expect(media).toHaveBeenCalledOnce();
    const before = service.get(session.id).public.preflight!.preview;
    await service.preflight(session.id, { check: 'cpu' });
    expect(media).toHaveBeenCalledOnce();
    expect(service.get(session.id).public.preflight!.preview).toEqual(before);
  });

  it('cancels an in-flight program check before finalizing a prepared session', async () => {
    const { service, session, encoders } = await fixture('simulation', false);
    let entered = false;
    const realFixture = passingPreflight.media!;
    vi.spyOn(passingPreflight, 'media').mockImplementation(async (options) => {
      entered = true;
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ...await realFixture(options), completed: false };
    });
    const checking = service.preflight(session.id, {});
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(service.isCourtActive(session.courtSlug)).toBe(true);
    await expect(service.start(session.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.stop(session.id);
    await checking;
    expect(service.get(session.id).public).toMatchObject({ status: 'stopped', preflight: { status: 'cancelled' } });
    expect(encoders).toHaveLength(0);
  });

  it('reserves at most three program checks without imposing preview resource thresholds on a start', async () => {
    const { service, session, encoders } = await fixture('simulation', false);
    const sessions = [session];
    for (const courtSlug of ['pista-2', 'pista-3', 'pista-4']) sessions.push(await service.prepare({
      courtSlug, mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date().toISOString(), privacyStatus: 'private',
    }));
    let release!: () => void; let entered = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realFixture = passingPreflight.media!;
    vi.spyOn(passingPreflight, 'media').mockImplementation(async (options) => { entered++; await gate; return realFixture(options); });
    const results = Promise.allSettled(sessions.map((prepared) => service.preflight(prepared.id, {})));
    await vi.waitFor(() => expect(entered).toBe(3)); release();
    expect((await results).filter(({ status }) => status === 'fulfilled')).toHaveLength(3);
    const host = await passingPreflight.host!('/tmp');
    const measurement = vi.spyOn(passingPreflight, 'host').mockResolvedValue({ ...host, availableStorageBytes: 0, availableMemoryBytes: 0 });
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(measurement).not.toHaveBeenCalled();
    expect(encoders).toHaveLength(1);
  });

  it('allows starting after a low-disk diagnostic skips the preview', async () => {
    const host = await passingPreflight.host!('/tmp');
    const media = vi.fn(passingPreflight.media!);
    const { service, session, encoders } = await fixture('youtube', true, {
      host: async () => ({ ...host, availableStorageBytes: 100 * 1024 ** 2 }), media,
    });
    expect(service.get(session.id).public.preflight).toMatchObject({ status: 'blocked', preview: null });
    expect(service.get(session.id).public.preflight?.checks.find(({ id }) => id === 'camera')?.status).toBe('pending');
    expect(media).not.toHaveBeenCalled();
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(encoders).toHaveLength(1);
  });

  it('allows starting despite failed encoder and bitrate diagnostics', async () => {
    const { service, session, encoders } = await fixture('simulation', true, {
      media: async (options) => ({ ...await passingPreflight.media!(options), completed: false }),
    });
    const report = service.get(session.id).public.preflight;
    expect(report?.status).toBe('blocked');
    expect(report?.checks.find(({ id }) => id === 'encoder')?.status).toBe('blocked');
    expect(report?.checks.find(({ id }) => id === 'bitrate')?.status).toBe('blocked');
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(encoders).toHaveLength(1);
  });

  it('allows starting after an optional diagnostic is cancelled', async () => {
    const { service, session, encoders } = await fixture('simulation', false);
    // A persisted cancelled report must not prevent starting.
    service.get(session.id).public = { ...session, preflight: {
      id: session.id, status: 'cancelled', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      validUntil: null, checks: [], preview: null,
    } };
    await expect(service.start(session.id)).resolves.toMatchObject({ status: 'starting' });
    expect(encoders).toHaveLength(1);
  });

  it('recovers a failed overlay without restarting a healthy camera or encoder', async () => {
    const { service, session, encoders, overlays, recoverCapture, recoverOverlay } = await fixture();
    await service.start(session.id);
    encoders[0]!.progress(31);
    overlays[0]!.onState!({ status: 'failed', attempt: 5, lastFrameAt: new Date().toISOString(), holdingLastFrame: true, reason: 'Revisa el marcador.' });
    expect(service.get(session.id).public.status).toBe('failed');
    expect((await service.recover(session.id)).status).toBe('live');
    expect(recoverOverlay).toHaveBeenCalledWith('pista-1');
    expect(recoverCapture).not.toHaveBeenCalled();
    expect(encoders).toHaveLength(1);
    expect(encoders[0]!.kill).not.toHaveBeenCalled();
    expect(service.incidentHistory().filter(({ category }) => category === 'overlay').map(({ resolved }) => resolved)).toEqual([false, true]);
  });

  it('does not clear an overlay failure merely because the camera recovered', async () => {
    const { service, session, encoders, overlays, sources } = await fixture();
    await service.start(session.id); encoders[0]!.progress(31);
    overlays[0]!.onState!({ status: 'failed', attempt: 5, lastFrameAt: new Date().toISOString(), holdingLastFrame: true, reason: 'Revisa el marcador.' });
    sources[0]!.onState({ active: true, attempt: 5, exhausted: true, reason: 'Revisa la cámara.' });
    sources[0]!.onState({ active: false, attempt: 0, exhausted: false, reason: null });
    expect(service.get(session.id).public).toMatchObject({ status: 'failed', error: 'Revisa el marcador.' });
    overlays[0]!.onState!({ status: 'ready', attempt: 0, lastFrameAt: new Date().toISOString(), holdingLastFrame: false, reason: null });
    expect(service.get(session.id).public).toMatchObject({ status: 'live', error: null });
  });

  it('waits for the first validated overlay without resetting its bounded retry cycle through the encoder watchdog', async () => {
    const { service, session, encoders, overlays } = await fixture();
    vi.useFakeTimers(); await service.start(session.id);
    overlays[0]!.onState!({ status: 'starting', attempt: 0, lastFrameAt: null, holdingLastFrame: false, reason: 'Esperando marcador.' });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(encoders[0]!.kill).not.toHaveBeenCalled();
    overlays[0]!.onState!({ status: 'failed', attempt: 5, lastFrameAt: null, holdingLastFrame: false, reason: 'Revisa el marcador.' });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(service.get(session.id).public.status).toBe('failed');
    expect(encoders).toHaveLength(1);
    expect(encoders[0]!.kill).not.toHaveBeenCalled();
    await service.recover(session.id);
    expect(service.get(session.id).public.status).toBe('starting');
    encoders[0]!.progress(1);
    expect(service.get(session.id).public.status).toBe('live');
  });

  it('waits for output shutdown, forces an unresponsive encoder and makes repeated shutdown idempotent', async () => {
    const { service, session, encoders } = await fixture();
    vi.useFakeTimers();
    await service.start(session.id);
    const encoder = encoders[0]!;
    encoder.kill.mockImplementation((signal?: string) => {
      if (signal === 'SIGKILL') encoder.emit('close', null);
      return true;
    });
    const closing = service.shutdown();
    expect(service.shutdown()).toBe(closing);
    await vi.waitFor(() => expect(encoder.kill).toHaveBeenCalledWith('SIGTERM'));
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(encoder.kill).toHaveBeenCalledWith('SIGKILL');
    expect(service.get(session.id).process).toBeNull();
    expect(encoders).toHaveLength(1);
  });

  it('keeps the output reserved after capture retries exhaust and recovers only the camera', async () => {
    const { service, session, encoders, sources } = await fixture();
    await service.start(session.id);
    const encoder = encoders[0]!;
    encoder.progress(31);
    sources[0]!.onState({ active: true, attempt: 5, exhausted: true, reason: 'Comprueba la cámara y recupera la emisión.' });
    expect(service.get(session.id).public.status).toBe('failed');
    expect(service.isCourtActive('pista-1')).toBe(true);
    expect(encoder.kill).not.toHaveBeenCalled();
    const recovered = await service.recover(session.id);
    expect(recovered).toMatchObject({ status: 'live', continuity: { active: false, exhausted: false }, error: null });
    expect(encoders).toHaveLength(1);
    const incidents = service.incidentHistory().filter(({ category }) => category === 'continuity');
    expect(incidents.map(({ resolved }) => resolved)).toEqual([false, true]);
    await service.stop(session.id);
    expect(service.isCourtActive('pista-1')).toBe(false);
  });

  it('reports source warnings without restarting a live encoder and preserves their history across restart', async () => {
    const { service, session, encoders, createService } = await fixture();
    vi.useFakeTimers();
    await service.start(session.id);
    const encoder = encoders[0]!;
    encoder.progress(1);
    const video = encoder.stdio[4] as PassThrough;
    video.write('frame:0 pts:0 pts_time:0\nlavfi.blackframe.pblack=100\n');
    await vi.advanceTimersByTimeAsync(10_000);
    video.write('frame:20 pts:20 pts_time:10\nlavfi.blackframe.pblack=100\nlavfi.freezedetect.freeze_start=0\n');
    encoder.progress(301);
    expect(service.get(session.id).public.status).toBe('live');
    expect(service.get(session.id).public.signal?.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['black_video', 'frozen_video']));
    expect(encoder.kill).not.toHaveBeenCalled();
    await service.shutdown();
    const restarted = createService();
    await restarted.initialize();
    cleanups.push(() => restarted.shutdown());
    expect(restarted.incidentHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'signal', courtSlug: 'pista-1', signalCode: 'black_video', severity: 'warning', resolved: false }),
    ]));
    expect(restarted.get(session.id).public.signal).toBeNull();
  });

  it('does not report a running continuity program after the server restarts', async () => {
    const { service, session, encoders, sources, createService } = await fixture();
    await service.start(session.id);
    encoders[0]!.progress(31);
    sources[0]!.onState({ active: true, attempt: 5, exhausted: true, reason: 'Revisa la cámara.' });
    await service.shutdown();
    const restarted = createService();
    await restarted.initialize();
    cleanups.push(() => restarted.shutdown());
    expect(restarted.get(session.id).public).toMatchObject({ status: 'interrupted', continuity: null, encoder: null });
  });

  const preparation = () => ({
    courtSlug: 'pista-2', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
    matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), privacyStatus: 'private',
  });

  it('restores a partial preparation after restart, recovers the same destination and never exposes ingest credentials', async () => {
    const { service, youtube, createService, encoders, health } = await fixture();
    vi.mocked(youtube.prepareBroadcast).mockImplementationOnce(async ({ recovery, checkpoint }) => {
      await checkpoint(YouTubePreparationSchema.parse({ ...recovery, channelId: 'channel',
        broadcastAttemptAt: new Date().toISOString(), broadcastId: 'partial-broadcast' }));
      throw new Error('private upstream failure');
    });
    await expect(service.prepare(preparation())).rejects.toThrow();
    const partial = (await service.list()).find(({ courtSlug }) => courtSlug === 'pista-2')!;
    expect(partial).toMatchObject({ status: 'failed', preparationPending: true, broadcastId: 'partial-broadcast' });
    await expect(service.prepare(preparation())).rejects.toThrow();
    await service.shutdown();
    vi.spyOn(youtube, 'inspectPreparation').mockImplementation(async (state) => state);
    health.mockResolvedValue({ broadcastStatus: 'ready', streamStatus: 'inactive', healthStatus: 'good' });
    const restarted = createService();
    await restarted.initialize();
    cleanups.push(() => restarted.shutdown());
    vi.mocked(youtube.prepareBroadcast).mockImplementationOnce(async ({ recovery }) => {
      expect(recovery.broadcastId).toBe('partial-broadcast');
      return { broadcastId: 'partial-broadcast', streamId: 'stream', ingestUrl: 'rtmps://example.test/private-secret', watchUrl: 'https://youtube.com/watch?v=partial-broadcast' };
    });
    const recovered = await restarted.recover(partial.id);
    expect(recovered).toMatchObject({ id: partial.id, status: 'prepared', preparationPending: false, broadcastId: 'partial-broadcast' });
    expect(encoders).toHaveLength(0);
    const exposed = JSON.stringify({ sessions: await restarted.list(), operations: restarted.operationHistory(), incidents: restarted.incidentHistory() });
    expect(exposed).not.toMatch(/private-secret|private upstream|ingestUrl|channelId/);
    expect(restarted.operationHistory().find(({ kind, courtSlug }) => kind === 'prepare' && courtSlug === 'pista-2')?.status).toBe('completed');
  });

  it('cancels a preparation with no attempted remote insert even when YouTube is unavailable', async () => {
    const { service, youtube } = await fixture();
    vi.mocked(youtube.prepareBroadcast).mockRejectedValueOnce(new Error('offline'));
    const cancel = vi.spyOn(youtube, 'cancelPreparation').mockRejectedValue(new Error('offline'));
    await expect(service.prepare(preparation())).rejects.toThrow();
    const partial = (await service.list()).find(({ courtSlug }) => courtSlug === 'pista-2')!;
    expect((await service.stop(partial.id)).status).toBe('stopped');
    expect(cancel).not.toHaveBeenCalled();
    expect((await service.prepare(preparation())).status).toBe('prepared');
  });

  it('aborts an in-flight preparation before reconciling cancellation and releases its court', async () => {
    const { service, youtube } = await fixture();
    let entered = false;
    vi.mocked(youtube.prepareBroadcast).mockImplementationOnce(async ({ recovery, checkpoint, signal }) => {
      await checkpoint(YouTubePreparationSchema.parse({ ...recovery, broadcastAttemptAt: new Date().toISOString() }));
      entered = true;
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      throw new Error('unreachable');
    });
    const cancel = vi.spyOn(youtube, 'cancelPreparation').mockResolvedValue();
    const preparing = service.prepare(preparation());
    const outcome = Promise.allSettled([preparing]);
    await vi.waitFor(() => expect(entered).toBe(true));
    const partial = (await service.list()).find(({ courtSlug }) => courtSlug === 'pista-2')!;
    expect(partial.status).toBe('preparing');
    expect((await service.stop(partial.id)).status).toBe('stopped');
    expect((await outcome)[0]?.status).toBe('rejected');
    expect(cancel).toHaveBeenCalledOnce();
    expect((await service.prepare(preparation())).status).toBe('prepared');
  });

  it('keeps the three-encoder limit when four courts finish asynchronous match validation together', async () => {
    const { service, session, encoders, binding } = await fixture();
    const sessions = [session];
    for (const courtSlug of ['pista-2', 'pista-3', 'pista-4']) sessions.push(await service.prepare({
      courtSlug, mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: new Date().toISOString(), privacyStatus: 'private',
    }));
    for (const prepared of sessions) await service.preflight(prepared.id, {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    vi.spyOn(binding, 'assertConfigured').mockImplementation(async () => {
      entered += 1;
      await gate;
      return { homeTeamId: 'kings', awayTeamId: 'lions' };
    });
    const attempts = Promise.allSettled(sessions.map((session) => service.start(session.id)));
    await vi.waitFor(() => expect(entered).toBe(4));
    release();
    const results = await attempts;
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(encoders).toHaveLength(3);
  }, 10_000);

  it('recovers a stuck encoder within 30 seconds even without a browser polling', async () => {
    const { service, session, encoders } = await fixture();
    vi.useFakeTimers();
    await service.start(session.id);
    encoders[0]?.progress(1);
    await vi.advanceTimersByTimeAsync(21_100);
    expect(encoders[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(encoders).toHaveLength(2);
    expect(service.get(session.id).public.status).toBe('starting');
  });

  it('exhausts five retries despite briefly producing frames, including unexpected exit zero', async () => {
    const { service, session, encoders } = await fixture();
    vi.useFakeTimers();
    await service.start(session.id);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      encoders.at(-1)?.progress(1);
      encoders.at(-1)?.emit('close', 0);
      await vi.advanceTimersByTimeAsync(delay);
    }
    encoders.at(-1)?.progress(1);
    encoders.at(-1)?.emit('close', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(encoders).toHaveLength(6);
    expect(service.get(session.id).public.status).toBe('failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(encoders).toHaveLength(6);
  });

  it('preserves an unresolved YouTube stop and allows an independent retry without restarting the encoder', async () => {
    const { service, session, encoders, complete } = await fixture('youtube');
    await service.start(session.id);
    complete.mockRejectedValueOnce(new Error('private upstream failure'));
    const stopped = await service.stop(session.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toContain('no ha confirmado el cierre');
    await expect(service.recover(session.id)).rejects.toThrow('cierre remoto está pendiente');
    expect((await service.stop(session.id)).status).toBe('stopped');
    expect(encoders).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('does not send an interrupted session back to a broadcast that YouTube already completed', async () => {
    const { service, session, encoders, health } = await fixture('youtube');
    service.get(session.id).public = { ...session, status: 'interrupted' };
    health.mockResolvedValue({ broadcastStatus: 'complete', streamStatus: 'inactive', healthStatus: 'good' });
    await expect(service.recover(session.id)).rejects.toThrow('ya ha cerrado');
    expect(service.get(session.id).public.status).toBe('stopped');
    expect(encoders).toHaveLength(0);
  });
});
