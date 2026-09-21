import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicationJob, RecordingAsset } from '@kpl/production-contracts';
import { RecordingLibrary } from '../src/recording-library.js';
import type { PilotYouTubeGateway } from '../src/pilot-youtube.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe('recording library', () => {
  it('persists one resumable upload, reconciles it after restart and schedules publication', async () => {
    const fixture = await createFixture();
    const gateway = fakeGateway();
    const library = new RecordingLibrary(fixture.indexPath, '/bin/false', gateway.value);
    await library.initialize();
    const created = await library.createUpload(fixture.asset.id, { title: 'Kings vs Lions', description: 'Jornada KPL' });
    await waitUntil(() => library.listJobs()[0]?.state === 'private_ready');
    expect(gateway.create).toHaveBeenCalledTimes(1);
    expect(gateway.chunk).toHaveBeenCalledTimes(1);
    expect(library.listJobs()[0]).toMatchObject({ id: created.id, uploadedBytes: 16, youtubeVideoId: 'video-1' });

    const publishAt = '2099-01-01T18:00:00.000Z';
    await library.schedule(created.id, { publishAt });
    expect(library.listJobs()[0]).toMatchObject({ state: 'scheduled', publishAt });
    await library.shutdown();
    expect((await stat(fixture.indexPath)).mode & 0o777).toBe(0o600);

    const restarted = new RecordingLibrary(fixture.indexPath, '/bin/false', gateway.value);
    await restarted.initialize();
    expect(restarted.listJobs()).toHaveLength(1);
    expect(restarted.listJobs()[0]).toMatchObject({ id: created.id, state: 'scheduled', youtubeVideoId: 'video-1' });
    await expect(restarted.createUpload(fixture.asset.id, { title: 'Duplicado', description: '' }))
      .resolves.toMatchObject({ id: created.id });
    expect(gateway.create).toHaveBeenCalledTimes(1);
    await restarted.shutdown();
  });

  it('resumes from the persisted upload URL without creating a duplicate remote video', async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    const paused: PublicationJob = {
      id: '11111111-1111-4111-8111-111111111111', assetId: fixture.asset.id, state: 'paused',
      title: fixture.asset.title, description: '', uploadUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=kept',
      uploadedBytes: 8, totalBytes: 16, youtubeVideoId: null, watchUrl: null, publishAt: null,
      createdAt: now, updatedAt: now, error: null,
    };
    await writeFile(fixture.indexPath, JSON.stringify({ assets: [fixture.asset], jobs: [paused] }));
    await chmod(fixture.indexPath, 0o600);
    const gateway = fakeGateway();
    gateway.query.mockResolvedValue({ uploadedBytes: 16, videoId: 'video-recovered' });
    const library = new RecordingLibrary(fixture.indexPath, '/bin/false', gateway.value);
    await library.initialize();
    await library.resume(paused.id);
    await waitUntil(() => library.listJobs()[0]?.state === 'private_ready');
    expect(gateway.query).toHaveBeenCalledWith(paused.uploadUrl, 16);
    expect(gateway.create).not.toHaveBeenCalled();
    expect(library.listJobs()[0]?.youtubeVideoId).toBe('video-recovered');
    await library.shutdown();
  });
});

async function createFixture(): Promise<{ indexPath: string; asset: RecordingAsset }> {
  const root = await mkdtemp(join(tmpdir(), 'kpl-recording-library-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const indexPath = join(root, 'recording-library.json');
  const path = join(dirname(indexPath), 'recordings', 'pista-1', 'part-1.mp4');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(16, 1));
  const now = new Date().toISOString();
  const asset: RecordingAsset = {
    id: 'a'.repeat(64), sessionId: '22222222-2222-4222-8222-222222222222', courtSlug: 'pista-1',
    title: 'Kings vs Lions', seasonLabel: 'T2', matchdayNumber: 1, path, createdAt: now, finalizedAt: now,
    sizeBytes: 16, durationSeconds: 60, streams: [{ kind: 'video', codec: 'h264' }, { kind: 'audio', codec: 'aac' }],
    state: 'ready', error: null,
  };
  await writeFile(indexPath, JSON.stringify({ assets: [asset], jobs: [] }));
  return { indexPath, asset };
}

function fakeGateway() {
  let scheduledAt: string | null = null;
  const create = vi.fn(async () => 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=new');
  const query = vi.fn(async () => ({ uploadedBytes: 0, videoId: null as string | null }));
  const chunk = vi.fn(async () => ({ uploadedBytes: 16, videoId: 'video-1' as string | null }));
  const inspect = vi.fn(async (id: string) => ({ id, uploadStatus: 'processed', privacyStatus: 'private', publishAt: scheduledAt }));
  const schedule = vi.fn(async (id: string, publishAt: string) => {
    scheduledAt = publishAt;
    return { id, uploadStatus: 'processed', privacyStatus: 'private', publishAt };
  });
  return { create, query, chunk, inspect, schedule, value: {
    createResumableVideoUpload: create, queryResumableVideoUpload: query, uploadVideoChunk: chunk,
    inspectUploadedVideo: inspect, scheduleUploadedVideo: schedule,
  } as unknown as PilotYouTubeGateway };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for publication state.');
}
