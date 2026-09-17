import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PilotMobileCameraLink } from '@kpl/production-contracts';
import { PilotMobileCameraService } from '../src/pilot-mobile-camera.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

const config = {
  mediaMtxPath: '/usr/local/bin/mediamtx', lanHost: '192.168.1.20', lanCidr: '192.168.1.0/24',
  cameraPageOrigin: 'https://live.kingspadelleague.es',
  webRtcPort: 18889, webRtcUdpPort: 18189, rtspPort: 18554, apiPort: 19998,
};
const capabilities = {
  cameras: [{ id: 'rear', label: 'Trasera', facingMode: 'environment', maxWidth: 1920, maxHeight: 1080,
    maxFramesPerSecond: 60, supportedProfiles: ['720p30', '1080p30', '1080p60'] }],
  audioAvailable: true,
};
const firstClient = '20000000-0000-4000-8000-000000000001';
const secondClient = '20000000-0000-4000-8000-000000000002';
function token(link: PilotMobileCameraLink) {
  return new URLSearchParams(new URL(link.connectUrl).hash.slice(1)).get('token')!;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-mobile-courts-'));
  const executable = join(directory, 'mediamtx');
  await writeFile(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  let now = Date.now();
  let child: ChildProcess | undefined;
  const ready = vi.fn(async (_port: number, process: ChildProcess) => { child = process; });
  const mutation = vi.fn<(port: number, method: string, path: string, body?: unknown) => Promise<void>>(async () => undefined);
  const service = new PilotMobileCameraService({ ...config, mediaMtxPath: executable }, directory, 4310,
    ready, () => true, () => now, mutation);
  service.initialize();
  cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { service, ready, mutation, child: () => child, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('independent mobile cameras per court', () => {
  it('creates courts concurrently with separate credentials, video paths and one shared process', async () => {
    const { service, ready, mutation, child } = await fixture();
    const [first, second, third] = await Promise.all([1, 2, 3].map((n) => service.create({ courtSlug: `pista-${n}` })));
    expect(first && second && third).toBeTruthy();
    if (!first || !second || !third) throw new Error('Missing links');
    expect(service.list()).toHaveLength(3);
    expect(new Set([first, second, third].map(token)).size).toBe(3);
    for (const link of [first, second, third]) {
      expect(new URL(link.connectUrl).origin).toBe('https://live.kingspadelleague.es');
      expect(service.rtspUrl(link.session.courtSlug)).toContain(link.session.id);
      expect(link.session.previewUrl).toContain(link.session.id);
      expect(JSON.stringify(service.list())).not.toContain(token(link));
    }
    const one = service.claim(first.session.id, token(first), { clientId: firstClient, capabilities });
    const two = service.claim(second.session.id, token(second), { clientId: secondClient, capabilities });
    expect(one.whipUrl).not.toBe(two.whipUrl);
    expect(one.whipUser).not.toBe(two.whipUser);
    expect(() => service.claim(second.session.id, token(first), { clientId: firstClient, capabilities })).toThrow('no es válido');
    await expect(service.create({ courtSlug: 'pista-1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(child()?.killed).toBe(false);
    expect(mutation.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(2);
  });

  it('isolates desired polling, readiness, FPS, audio and revocation', async () => {
    const { service, child } = await fixture();
    const first = await service.create({ courtSlug: 'pista-1' });
    const second = await service.create({ courtSlug: 'pista-2' });
    const one = service.claim(first.session.id, token(first), { clientId: firstClient, capabilities });
    const two = service.claim(second.session.id, token(second), {
      clientId: secondClient, capabilities: { ...capabilities, audioAvailable: false },
    });
    service.report(first.session.id, token(first), { clientId: firstClient, state: 'ready', applied: null, metrics: null, error: null });
    service.report(second.session.id, token(second), { clientId: secondClient, state: 'ready', applied: null, metrics: null, error: null });
    expect(service.isReadyForCourt('pista-1')).toBe(true);
    expect(service.isReadyForCourt('pista-2')).toBe(true);
    expect(service.isReadyForCourt('pista-3')).toBe(false);
    const pendingOne = service.waitForDesired(first.session.id, token(first), one.desired.revision);
    let secondResolved = false;
    const pendingTwo = service.waitForDesired(second.session.id, token(second), two.desired.revision)
      .then((desired) => { secondResolved = true; return desired; });
    service.updateDesired(first.session.id, { expectedRevision: one.desired.revision,
      cameraId: 'rear', profile: '1080p60', audioEnabled: true });
    expect((await pendingOne).profile).toBe('1080p60');
    expect(secondResolved).toBe(false);
    expect(service.framesPerSecondForCourt('pista-1')).toBe(60);
    expect(service.framesPerSecondForCourt('pista-2')).toBe(30);
    expect(service.audioAvailableForCourt('pista-1')).toBe(true);
    expect(service.audioAvailableForCourt('pista-2')).toBe(false);
    await service.revoke(first.session.id);
    expect(service.isReadyForCourt('pista-1')).toBe(false);
    expect(service.isReadyForCourt('pista-2')).toBe(true);
    expect(child()?.killed).toBe(false);
    expect(secondResolved).toBe(false);
    const replacement = await service.create({ courtSlug: 'pista-1' });
    expect(service.rtspUrl('pista-1')).toContain(replacement.session.id);
    expect(service.list()).toHaveLength(2);
    expect(() => service.claim(replacement.session.id, token(first), { clientId: firstClient, capabilities })).toThrow('no es válido');
    service.updateDesired(second.session.id, { expectedRevision: two.desired.revision,
      cameraId: 'rear', profile: '720p30', audioEnabled: false });
    expect((await pendingTwo).profile).toBe('720p30');
  });

  it('limits duplicate concurrent creation to one session per court and recovers from a failed add', async () => {
    const { service, mutation, child } = await fixture();
    const attempts = await Promise.allSettled([service.create({ courtSlug: 'pista-1' }), service.create({ courtSlug: 'pista-1' })]);
    expect(attempts.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    mutation.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(service.create({ courtSlug: 'pista-2' })).rejects.toMatchObject({ statusCode: 500 });
    expect(service.list().find(({ courtSlug }) => courtSlug === 'pista-1')?.state).toBe('waiting_permission');
    expect(child()?.killed).toBe(false);
    await expect(service.create({ courtSlug: 'pista-2' })).resolves.toMatchObject({ session: { state: 'waiting_permission' } });
  });

  it('expires one court without stopping a newer court or its pending request', async () => {
    const { service, advance, child } = await fixture();
    const first = await service.create({ courtSlug: 'pista-1' });
    advance(60_000);
    const second = await service.create({ courtSlug: 'pista-2' });
    advance(12 * 60 * 60_000 - 59_999);
    expect(() => service.claim(first.session.id, token(first), { clientId: firstClient, capabilities })).toThrow('caducado');
    service.claim(second.session.id, token(second), { clientId: secondClient, capabilities });
    const replacement = await service.create({ courtSlug: 'pista-1' });
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(service.current(second.session.id)?.state).toBe('connecting');
    expect(child()?.killed).toBe(false);
  });
});

it.runIf(existsSync(config.mediaMtxPath))('keeps a real MediaMTX publisher connected while another court is added and revoked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-mobile-real-'));
  const service = new PilotMobileCameraService(config, directory, 4310);
  service.initialize();
  cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const first = await service.create({ courtSlug: 'pista-1' });
  // FFmpeg's RTSP authentication needs a plain password; production cameras use hashed WHIP credentials.
  // Allow this test's loopback encoder only, without changing the production configuration.
  const api = `http://127.0.0.1:${config.apiPort}`;
  const global = await (await fetch(`${api}/v3/config/global/get`)).json();
  global.authInternalUsers[1].ips.push('127.0.0.1');
  global.authInternalUsers[1].pass = token(first);
  expect((await fetch(`${api}/v3/config/global/patch`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authInternalUsers: global.authInternalUsers }),
  })).ok).toBe(true);
  const input = new URL(service.rtspUrl('pista-1'));
  input.username = `camera-${first.session.id}`;
  input.password = token(first);
  const publisher = spawn('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
    '-i', 'testsrc2=size=160x90:rate=5', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast',
    '-tune', 'zerolatency', '-f', 'rtsp', '-rtsp_transport', 'tcp', input.toString()], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  publisher.stderr?.on('data', (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString()}`.slice(-2_000); });
  cleanups.push(async () => {
    if (publisher.exitCode !== null || publisher.signalCode !== null) return;
    await new Promise<void>((resolve) => { publisher.once('close', () => resolve()); publisher.kill('SIGKILL'); });
  });
  const getPath = async () => {
    const response = await fetch(`${api}/v3/paths/get/mobile-pilot-${first.session.id}`);
    return response.json();
  };
  await vi.waitFor(async () => {
    expect((await getPath()).ready, diagnostic.replaceAll(token(first), '[token]')).toBe(true);
  }, { timeout: 5_000 });
  const before = await getPath();
  const [second, third] = await Promise.all([
    service.create({ courtSlug: 'pista-2' }), service.create({ courtSlug: 'pista-3' }),
  ]);
  expect(service.list()).toHaveLength(3);
  expect((await getPath()).source).toEqual(before.source);
  await service.revoke(second.session.id);
  await service.revoke(third.session.id);
  const after = await getPath();
  expect(after.ready).toBe(true);
  expect(after.source).toEqual(before.source);
  expect(publisher.exitCode).toBeNull();
  await vi.waitFor(async () => {
    const current = await getPath();
    expect(current.bytesReceived).toBeGreaterThan(before.bytesReceived);
    expect(current.source).toEqual(before.source);
  }, { timeout: 5_000 });
}, 15_000);
