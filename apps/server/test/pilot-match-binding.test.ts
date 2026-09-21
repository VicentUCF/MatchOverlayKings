import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparePilotSessionInput } from '@kpl/production-contracts';
import { SupabasePilotMatchBinding, type PilotMatchBinding } from '../src/pilot-match-binding.js';
import { PilotService, PilotServiceError } from '../src/pilot-service.js';
import { PilotYouTubeError, PilotYouTubeGateway } from '../src/pilot-youtube.js';

const input: PreparePilotSessionInput = {
  courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings of Favar', awayTeam: 'Red Lions',
  matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: '2099-01-01T10:00:00.000Z', privacyStatus: 'private',
};
const identity = { homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions', overlayToken: 'a'.repeat(64) };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe('pilot match binding', () => {
  it('requires a configured database and an administrator session without making a request', async () => {
    const fetcher = vi.fn();
    await expect(new SupabasePilotMatchBinding(undefined, fetcher).configure(input, 'Bearer admin'))
      .rejects.toMatchObject({ code: 'NOT_READY' });
    await expect(new SupabasePilotMatchBinding({ url: 'https://db.example', publishableKey: 'public' }, fetcher).configure(input))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('migrates legacy mode-based configuration to versioned discriminated plans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-plan-migration-'));
    const path = join(directory, 'configurations.json');
    await writeFile(path, JSON.stringify([{ ...input, updatedAt: '2026-09-21T10:00:00.000Z' }]));
    const service = new PilotService('/bin/false', new PilotYouTubeGateway({
      clientId: null, clientSecret: null, redirectUri: null, tokenPath: null,
    }), path, undefined, undefined, { configure: async () => identity, assertConfigured: async () => identity });
    cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
    await service.initialize();
    expect(service.configurations()[0]).toMatchObject({ mode: 'recording', courtSlug: 'pista-1' });
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as { version: number; entries: Array<{ plan: { kind: string } }> };
    expect(snapshot.version).toBe(2);
    expect(snapshot.entries[0]?.plan.kind).toBe('recording');
  });

  it('sends authenticated configuration and read validation to the same authority', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith('configure_pilot_access')
      ? { token: identity.overlayToken, expiresAt: '2099-01-02T00:00:00.000Z' }
      : identity));
    const binding = new SupabasePilotMatchBinding({ url: 'https://db.example/', publishableKey: 'public' }, fetcher);
    await expect(binding.configure(input, 'Bearer admin')).resolves.toEqual(identity);
    await expect(binding.assertConfigured(input, 'Bearer admin')).resolves.toEqual(identity);
    expect(fetcher.mock.calls.map((call) => call)).toHaveLength(4);
    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://db.example/rest/v1/rpc/configure_pilot_match', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer admin', apikey: 'public' }),
      body: JSON.stringify({ p_configuration: input, p_apply: true }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://db.example/rest/v1/rpc/configure_pilot_access', expect.objectContaining({
      body: JSON.stringify({ p_court_slug: 'pista-1', p_kind: 'recording', p_season_label: 'T2', p_matchday_number: 1 }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, expect.any(String), expect.objectContaining({
      body: JSON.stringify({ p_configuration: input, p_apply: false }),
    }));
  });

  it('fails closed on mismatches, network errors and invalid responses', async () => {
    for (const fetcher of [
      vi.fn(async () => Response.json({ message: 'Partido distinto' }, { status: 400 })),
      vi.fn(async () => { throw new Error('offline'); }),
      vi.fn(async () => Response.json({})),
    ]) {
      const binding = new SupabasePilotMatchBinding({ url: 'https://db.example', publishableKey: 'public' }, fetcher);
      await expect(binding.assertConfigured(input, 'Bearer admin')).rejects.toBeInstanceOf(PilotServiceError);
    }
  });

  it('does not persist configuration or create a session when binding fails', async () => {
    const rejected = vi.fn(async () => { throw new PilotServiceError(409, 'CONFLICT', 'Partido distinto'); });
    const service = await createService({ configure: rejected, assertConfigured: rejected });
    await expect(service.configure('pista-1', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(service.configurations()).toEqual([]);
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await service.list()).toEqual([]);
  });

  it('blocks reconfiguration of a prepared session and allows it after stopping', async () => {
    const configure = vi.fn(async () => identity);
    const service = await createService({ configure, assertConfigured: async () => identity });
    await service.configure('pista-1', input);
    const prepared = await service.prepare(input);
    expect(service.get(prepared.id).overlay).toMatchObject(identity);
    await expect(service.configure('pista-1', { ...input, homeTeam: 'Another team' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(configure).toHaveBeenCalledTimes(1);
    await service.stop(prepared.id);
    await expect(service.configure('pista-1', input)).resolves.toMatchObject(input);
  });

  it('keeps a YouTube preparation locked when cancellation fails and allows a retry', async () => {
    const youtube = new PilotYouTubeGateway({ clientId: null, clientSecret: null, redirectUri: null, tokenPath: null });
    vi.spyOn(youtube, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(youtube, 'isAuthorized', 'get').mockReturnValue(true);
    vi.spyOn(youtube, 'prepareBroadcast').mockResolvedValue({
      broadcastId: 'broadcast', streamId: 'stream', ingestUrl: 'rtmp://example.invalid/stream', watchUrl: 'https://youtube.com/watch?v=broadcast',
    });
    const cancel = vi.spyOn(youtube, 'cancelBroadcast')
      .mockRejectedValueOnce(new PilotYouTubeError('API_ERROR'))
      .mockResolvedValueOnce(undefined);
    const service = await createService({ configure: async () => identity, assertConfigured: async () => identity }, youtube);
    const prepared = await service.prepare({ ...input, mode: 'youtube' });
    await expect(service.stop(prepared.id)).rejects.toBeInstanceOf(PilotServiceError);
    expect(service.get(prepared.id).public.status).toBe('prepared');
    await expect(service.configure('pista-1', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.stop(prepared.id)).resolves.toMatchObject({ status: 'stopped' });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('rejects competing configure and prepare operations while a court is being saved', async () => {
    let finish!: (value: typeof identity) => void;
    const service = await createService({
      configure: () => new Promise((resolve) => { finish = resolve; }),
      assertConfigured: async () => identity,
    });
    const saving = service.configure('pista-1', input);
    await expect(service.prepare(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.configure('pista-1', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    finish(identity);
    await saving;
  });
});

async function createService(binding: PilotMatchBinding, youtube = new PilotYouTubeGateway({
  clientId: null, clientSecret: null, redirectUri: null, tokenPath: null,
})): Promise<PilotService> {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-match-binding-'));
  const service = new PilotService('/bin/ffmpeg', youtube, join(directory, 'configurations.json'), undefined, undefined, binding);
  cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  await service.initialize();
  return service;
}
