import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { google } from 'googleapis';
import { PilotYouTubeError, PilotYouTubeGateway, youtubeApiErrorMessage } from '../src/pilot-youtube.js';

afterEach(() => vi.restoreAllMocks());

describe('idempotent YouTube closure', () => {
  it.each(['created', 'ready', 'live', 'testing', 'complete', 'revoked', 'missing'])('closes from observed status %s', async (status) => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-youtube-close-'));
    try {
      const tokenPath = join(directory, 'tokens');
      await writeFile(tokenPath, '{}', { mode: 0o600 });
      const gateway = new PilotYouTubeGateway({ clientId: 'test', clientSecret: 'test', redirectUri: 'http://localhost/callback', tokenPath });
      await gateway.initialize();
      const remove = vi.fn().mockResolvedValue({});
      const transition = vi.fn().mockResolvedValue({});
      const list = vi.fn().mockResolvedValue({ data: { items: status === 'missing' ? [] : [{ status: { lifeCycleStatus: status } }] } });
      vi.spyOn(google, 'youtube').mockReturnValue({ liveBroadcasts: { list, delete: remove, transition } } as unknown as ReturnType<typeof google.youtube>);
      await gateway.completeBroadcast('broadcast');
      expect(remove).toHaveBeenCalledTimes(['created', 'ready'].includes(status) ? 1 : 0);
      expect(transition).toHaveBeenCalledTimes(['live', 'testing'].includes(status) ? 1 : 0);
      if (['live', 'testing'].includes(status)) expect(transition).toHaveBeenCalledWith({ id: 'broadcast', broadcastStatus: 'complete', part: ['id', 'status'] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('YouTube API error presentation', () => {
  it.each([
    ['invalidScheduledStartTime', 'La fecha y hora no son válidas para YouTube. Programa la emisión para un momento futuro.'],
    ['liveStreamingNotEnabled', 'El canal de YouTube todavía no tiene habilitadas las emisiones en directo.'],
    ['quotaExceeded', 'Se ha agotado la cuota diaria de la API de YouTube.'],
  ])('maps %s to an actionable message', (reason, expected) => {
    expect(youtubeApiErrorMessage({
      response: { data: { error: { errors: [{ reason }] } } },
    })).toBe(expected);
  });

  it('keeps unknown API failures generic', () => {
    expect(new PilotYouTubeError('API_ERROR').message).toBe('YouTube no pudo completar la operación.');
    expect(youtubeApiErrorMessage(new Error('secret upstream detail')))
      .toBe('YouTube no pudo completar la operación.');
  });
});

describe('resumable private video uploads', () => {
  it('creates a private resumable session and restores the acknowledged byte offset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-youtube-upload-'));
    try {
      const tokenPath = join(directory, 'tokens');
      await writeFile(tokenPath, JSON.stringify({ access_token: 'token' }), { mode: 0o600 });
      const gateway = new PilotYouTubeGateway({ clientId: 'test', clientSecret: 'test', redirectUri: 'http://localhost/callback', tokenPath });
      await gateway.initialize();
      const fetcher = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one' } }))
        .mockResolvedValueOnce(new Response('', { status: 308, headers: { range: 'bytes=0-7' } }));
      const uploadUrl = await gateway.createResumableVideoUpload({ title: 'Partido', description: 'KPL', sizeBytes: 16 });
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ status: { privacyStatus: 'private' } });
      await expect(gateway.queryResumableVideoUpload(uploadUrl, 16)).resolves.toEqual({ uploadedBytes: 8, videoId: null });
      await expect(gateway.queryResumableVideoUpload('https://example.com/upload/youtube/v3/videos', 16))
        .rejects.toBeInstanceOf(PilotYouTubeError);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('programs publishAt while keeping the processed video private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kpl-youtube-schedule-'));
    try {
      const tokenPath = join(directory, 'tokens');
      await writeFile(tokenPath, JSON.stringify({ access_token: 'token' }), { mode: 0o600 });
      const gateway = new PilotYouTubeGateway({ clientId: 'test', clientSecret: 'test', redirectUri: 'http://localhost/callback', tokenPath });
      await gateway.initialize();
      const update = vi.fn().mockResolvedValue({});
      const list = vi.fn().mockResolvedValue({ data: { items: [{
        status: { uploadStatus: 'processed', privacyStatus: 'private', publishAt: '2099-01-01T18:00:00Z' },
      }] } });
      vi.spyOn(google, 'youtube').mockReturnValue({ videos: { update, list } } as unknown as ReturnType<typeof google.youtube>);
      await expect(gateway.scheduleUploadedVideo('video-1', '2099-01-01T18:00:00Z')).resolves.toMatchObject({
        id: 'video-1', privacyStatus: 'private', publishAt: '2099-01-01T18:00:00Z',
      });
      expect(update).toHaveBeenCalledWith({ part: ['status'], requestBody: {
        id: 'video-1', status: { privacyStatus: 'private', publishAt: '2099-01-01T18:00:00Z' },
      } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
