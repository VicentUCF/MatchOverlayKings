import type { youtube_v3 } from 'googleapis';
import { describe, expect, it, vi } from 'vitest';
import { YouTubePreparationSchema, YouTubePreparationTransaction, type YouTubePreparation } from '../src/pilot-youtube-preparation.js';

const input = { title: 'Kings vs Lions', description: 'Descripción del partido', scheduledAt: '2099-01-01T12:00:00.000Z',
  privacyStatus: 'unlisted' as const, thumbnail: new Uint8Array([1, 2]) };

function fixture() {
  let now = Date.parse('2026-09-19T12:00:00.000Z');
  let saved = YouTubePreparationSchema.parse({ operationId: '123e4567-e89b-42d3-a456-426614174000', framesPerSecond: 30 });
  const checkpoints: YouTubePreparation[] = [];
  const checkpoint = vi.fn(async (state: YouTubePreparation) => { saved = structuredClone(state); checkpoints.push(saved); });
  const broadcasts = new Map<string, youtube_v3.Schema$LiveBroadcast>();
  const streams = new Map<string, youtube_v3.Schema$LiveStream>();
  const channels = { list: vi.fn(async () => ({ data: { items: [{ id: 'channel-a' }] } })) };
  const liveBroadcasts = {
    insert: vi.fn(async (params: youtube_v3.Params$Resource$Livebroadcasts$Insert) => {
      expect(saved.broadcastAttemptAt).not.toBeNull();
      const id = `broadcast-${broadcasts.size + 1}`;
      broadcasts.set(id, { ...params.requestBody, id, snippet: { ...params.requestBody?.snippet, channelId: 'channel-a' }, status: { ...params.requestBody?.status, lifeCycleStatus: 'created' } });
      return { data: structuredClone(broadcasts.get(id)!) };
    }),
    list: vi.fn(async (params: youtube_v3.Params$Resource$Livebroadcasts$List) => ({ data: { items: [...broadcasts.values()].filter(({ id }) => !params.id || params.id.includes(id!)) } })),
    bind: vi.fn(async (params: youtube_v3.Params$Resource$Livebroadcasts$Bind) => {
      const broadcast = broadcasts.get(params.id!)!;
      broadcast.contentDetails = { ...broadcast.contentDetails, boundStreamId: params.streamId ?? null };
      broadcast.status = { ...broadcast.status, lifeCycleStatus: 'ready' };
      return { data: broadcast };
    }),
    delete: vi.fn(async ({ id }: { id: string }) => { broadcasts.delete(id); }),
    transition: vi.fn(async ({ id }: { id: string }) => { broadcasts.get(id)!.status = { lifeCycleStatus: 'complete' }; }),
  };
  const liveStreams = {
    insert: vi.fn(async (params: youtube_v3.Params$Resource$Livestreams$Insert) => {
      expect(saved.broadcastId).not.toBeNull();
      expect(saved.streamAttemptAt).not.toBeNull();
      const id = `stream-${streams.size + 1}`;
      streams.set(id, { id, snippet: { ...params.requestBody?.snippet, channelId: 'channel-a' },
        cdn: { ...params.requestBody?.cdn, ingestionInfo: { rtmpsIngestionAddress: 'rtmps://ingest.example/live', streamName: 'private-stream-key' } } });
      return { data: structuredClone(streams.get(id)!) };
    }),
    list: vi.fn(async (params: youtube_v3.Params$Resource$Livestreams$List) => ({ data: { items: [...streams.values()].filter(({ id }) => !params.id || params.id.includes(id!)) } })),
    delete: vi.fn(async ({ id }: { id: string }) => { streams.delete(id); }),
  };
  const thumbnails = { set: vi.fn(async () => ({ data: {} })) };
  const videos = {
    list: vi.fn(async ({ id }: { id: string[] }) => ({ data: { items: [{ id: id[0], snippet: { categoryId: '17', tags: ['kpl'], defaultLanguage: 'es' }, status: { embeddable: true, license: 'youtube', publicStatsViewable: false } }] } })),
    update: vi.fn(async (params: youtube_v3.Params$Resource$Videos$Update) => {
      expect(saved.broadcastId).not.toBeNull();
      expect(saved.streamId).not.toBeNull();
      const broadcast = broadcasts.get(params.requestBody!.id!)!;
      broadcast.snippet = { ...broadcast.snippet, description: params.requestBody?.snippet?.description ?? null };
      broadcast.status = { ...broadcast.status, privacyStatus: params.requestBody?.status?.privacyStatus ?? null };
      return { data: params.requestBody };
    }),
  };
  const client = { channels, liveBroadcasts, liveStreams, thumbnails, videos };
  return {
    client, checkpoint, checkpoints, broadcasts, streams,
    get saved() { return saved; },
    advance: (ms: number) => { now += ms; },
    transaction: (state = saved, save = checkpoint) => new YouTubePreparationTransaction(client as unknown as youtube_v3.Youtube, state, save, undefined, () => now),
  };
}

describe('recoverable YouTube preparation', () => {
  it('persists intent before each insert, stages privately and applies exact metadata only at the end', async () => {
    const f = fixture();
    const result = await f.transaction().prepare(input);
    expect(result).toMatchObject({ ready: true, broadcastId: 'broadcast-1', streamId: 'stream-1', ingestUrl: 'rtmps://ingest.example/live/private-stream-key' });
    const initial = f.client.liveBroadcasts.insert.mock.calls[0]?.[0].requestBody;
    expect(initial?.status?.privacyStatus).toBe('private');
    expect(initial?.contentDetails).toMatchObject({ enableAutoStart: true, enableAutoStop: false });
    expect(initial?.snippet?.description).toContain(`[KPL:${f.saved.operationId}]`);
    const final = f.client.videos.update.mock.calls[0]?.[0].requestBody;
    expect(final).toMatchObject({ snippet: { title: input.title, description: input.description, categoryId: '17', tags: ['kpl'], defaultLanguage: 'es' },
      status: { privacyStatus: 'unlisted', embeddable: true, license: 'youtube', publicStatsViewable: false, selfDeclaredMadeForKids: false } });
    expect(JSON.stringify(final)).not.toContain('[KPL:');
    expect(f.checkpoints.findIndex(({ broadcastAttemptAt }) => broadcastAttemptAt !== null))
      .toBeLessThan(f.checkpoints.findIndex(({ broadcastId }) => broadcastId !== null));
  });

  it.each(['broadcast', 'stream'] as const)('recovers a lost %s insert response without inserting a second resource', async (kind) => {
    const f = fixture();
    if (kind === 'broadcast') {
      const insert = f.client.liveBroadcasts.insert.getMockImplementation()!;
      f.client.liveBroadcasts.insert.mockImplementationOnce(async (params) => { await insert(params); throw new Error('response lost'); });
    } else {
      const insert = f.client.liveStreams.insert.getMockImplementation()!;
      f.client.liveStreams.insert.mockImplementationOnce(async (params) => { await insert(params); throw new Error('response lost'); });
    }
    await expect(f.transaction().prepare(input)).rejects.toThrow('response lost');
    expect((await f.transaction().prepare(input)).ready).toBe(true);
    expect(f.client.liveBroadcasts.insert).toHaveBeenCalledTimes(1);
    expect(f.client.liveStreams.insert).toHaveBeenCalledTimes(1);
  });

  it('recovers after final metadata was applied but its response was lost', async () => {
    const f = fixture();
    const update = f.client.videos.update.getMockImplementation()!;
    f.client.videos.update.mockImplementationOnce(async (params) => { await update(params); throw new Error('response lost'); });
    await expect(f.transaction().prepare(input)).rejects.toThrow();
    expect(f.broadcasts.get('broadcast-1')?.snippet?.description).toBe(input.description);
    await f.transaction().prepare(input);
    expect(f.client.liveBroadcasts.insert).toHaveBeenCalledTimes(1);
    expect(f.client.liveStreams.insert).toHaveBeenCalledTimes(1);
    expect(f.saved.ready).toBe(true);
  });

  it('does not repeat an ambiguous insert and requires two delayed absence checks before cancellation', async () => {
    const f = fixture();
    f.client.liveBroadcasts.insert.mockRejectedValueOnce(new Error('timeout'));
    await expect(f.transaction().prepare(input)).rejects.toThrow();
    await expect(f.transaction().prepare(input)).rejects.toThrow('no se creará otro');
    await expect(f.transaction().cancel()).rejects.toThrow('Espera un minuto');
    f.advance(60_000);
    await expect(f.transaction().cancel()).resolves.toBeUndefined();
    expect(f.client.liveBroadcasts.insert).toHaveBeenCalledTimes(1);
  });

  it('refuses recovery or cancellation under another channel', async () => {
    const f = fixture();
    await f.transaction().prepare(input);
    f.client.channels.list.mockResolvedValue({ data: { items: [{ id: 'channel-b' }] } });
    await expect(f.transaction().cancel()).rejects.toThrow('mismo canal');
    expect(f.client.liveBroadcasts.delete).not.toHaveBeenCalled();
  });

  it('cancels all known partial resources idempotently without creating any new ones', async () => {
    const f = fixture();
    f.client.thumbnails.set.mockRejectedValueOnce(new Error('thumbnail failed'));
    await expect(f.transaction().prepare(input)).rejects.toThrow();
    await f.transaction().cancel();
    await f.transaction().cancel();
    expect(f.broadcasts.size).toBe(0);
    expect(f.streams.size).toBe(0);
    expect(f.client.liveBroadcasts.delete).toHaveBeenCalledTimes(1);
    expect(f.client.liveStreams.delete).toHaveBeenCalledTimes(1);
  });

  it('does not insert anything when the local checkpoint cannot be committed', async () => {
    const f = fixture();
    const checkpoint = vi.fn(async (state: YouTubePreparation) => {
      if (state.broadcastAttemptAt !== null) throw new Error('disk full');
    });
    await expect(f.transaction(f.saved, checkpoint).prepare(input)).rejects.toThrow('disk full');
    expect(f.client.liveBroadcasts.insert).not.toHaveBeenCalled();
  });

  it('does not replace a different stream someone bound to the same broadcast', async () => {
    const f = fixture();
    f.client.thumbnails.set.mockRejectedValueOnce(new Error('thumbnail failed'));
    await expect(f.transaction().prepare(input)).rejects.toThrow();
    f.broadcasts.get('broadcast-1')!.contentDetails = { boundStreamId: 'another-stream' };
    await expect(f.transaction().prepare(input)).rejects.toThrow('otra entrada');
    expect(f.client.liveBroadcasts.bind).toHaveBeenCalledTimes(1);
  });
});
