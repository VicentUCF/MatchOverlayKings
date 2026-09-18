import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparePilotSessionInput } from '@kpl/production-contracts';
import type { PilotOverlayRenderer } from '../src/pilot-overlay.js';
import { PilotService } from '../src/pilot-service.js';
import { PilotYouTubeGateway } from '../src/pilot-youtube.js';
import { SupabasePilotStreamLink, type PilotStreamLink } from '../src/pilot-stream-link.js';

const watchUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const identity = { homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' };
const input: PreparePilotSessionInput = {
  courtSlug: 'pista-1', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings of Favar', awayTeam: 'Red Lions',
  matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: '2099-01-01T10:00:00.000Z', privacyStatus: 'private',
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.(); });

describe('public stream link', () => {
  it('requires a configured database and an operator session without making a request', async () => {
    const fetcher = vi.fn();
    await expect(new SupabasePilotStreamLink(undefined, fetcher).publish('pista-1', watchUrl, 'Bearer operator'))
      .rejects.toThrow();
    await expect(new SupabasePilotStreamLink({ url: 'https://db.example', publishableKey: 'public' }, fetcher)
      .publish('pista-1', watchUrl)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('publishes the court link through the operator session', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const link = new SupabasePilotStreamLink({ url: 'https://db.example/', publishableKey: 'public' }, fetcher);

    await link.publish('pista-1', watchUrl, 'Bearer operator');

    expect(fetcher).toHaveBeenCalledWith('https://db.example/rest/v1/rpc/publish_court_stream', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer operator', apikey: 'public' }),
      body: JSON.stringify({ p_court_slug: 'pista-1', p_watch_url: watchUrl }),
    }));
  });

  it('reports a rejected publication', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    const link = new SupabasePilotStreamLink({ url: 'https://db.example', publishableKey: 'public' }, fetcher);

    await expect(link.publish('pista-1', watchUrl, 'Bearer operator')).rejects.toThrow();
  });

  it('publishes the link when the emission starts and clears it when it stops', async () => {
    const publish = vi.fn(async () => undefined);
    const service = await createService({ publish });
    const prepared = await service.prepare(input, 'Bearer operator');

    await service.start(prepared.id, 'Bearer operator');
    expect(publish).toHaveBeenLastCalledWith('pista-1', watchUrl, 'Bearer operator');

    await service.stop(prepared.id, 'Bearer operator');
    expect(publish).toHaveBeenLastCalledWith('pista-1', null, 'Bearer operator');
  }, 15_000);

  it('never stops the emission when the public link cannot be published', async () => {
    const publish = vi.fn(async () => { throw new Error('offline'); });
    const service = await createService({ publish });
    const prepared = await service.prepare(input, 'Bearer operator');

    await expect(service.start(prepared.id, 'Bearer operator')).resolves.toMatchObject({ id: prepared.id });
    await expect(service.stop(prepared.id, 'Bearer operator')).resolves.toMatchObject({ id: prepared.id });
    expect(publish).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('leaves the public link alone for a local simulation', async () => {
    const publish = vi.fn(async () => undefined);
    const service = await createService({ publish });
    const prepared = await service.prepare({ ...input, mode: 'simulation' }, 'Bearer operator');

    await service.stop(prepared.id, 'Bearer operator');

    expect(publish).not.toHaveBeenCalled();
  });
});

async function createService(streamLink: PilotStreamLink): Promise<PilotService> {
  const youtube = new PilotYouTubeGateway({ clientId: null, clientSecret: null, redirectUri: null, tokenPath: null });
  vi.spyOn(youtube, 'prepareBroadcast').mockResolvedValue({
    broadcastId: 'dQw4w9WgXcQ', streamId: 'stream', ingestUrl: 'rtmp://127.0.0.1:1/live', watchUrl,
  });
  vi.spyOn(youtube, 'cancelBroadcast').mockResolvedValue(undefined);
  vi.spyOn(youtube, 'completeBroadcast').mockResolvedValue(undefined);
  const directory = await mkdtemp(join(tmpdir(), 'kpl-stream-link-'));
  const service = new PilotService(
    '/bin/ffmpeg',
    youtube,
    join(directory, 'configurations.json'),
    undefined,
    silentOverlayRenderer(),
    { configure: async () => identity, assertConfigured: async () => identity },
    streamLink,
  );
  cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  await service.initialize();
  return service;
}

function silentOverlayRenderer(): PilotOverlayRenderer {
  return {
    close: async () => undefined,
    start: async (output: Writable, _options, signal) => {
      output.on('error', () => undefined);
      while (!signal.aborted && !output.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!output.destroyed) output.end();
    },
  };
}
