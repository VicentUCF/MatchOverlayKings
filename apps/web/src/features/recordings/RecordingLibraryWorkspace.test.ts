import { describe, expect, it } from 'vitest';
import type { PublicationJob } from '@kpl/production-contracts';
import { recordingPollDelay, type LibraryState } from './RecordingLibraryWorkspace.js';

const baseJob: PublicationJob = {
  id: '11111111-1111-4111-8111-111111111111', assetId: 'a'.repeat(64), state: 'processing',
  title: 'Partido', description: '', uploadUrl: null, uploadedBytes: 10, totalBytes: 10,
  youtubeVideoId: 'video-1', watchUrl: 'https://www.youtube.com/watch?v=video-1', publishAt: null,
  createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z', error: null,
};

function ready(job: PublicationJob): LibraryState {
  return { kind: 'ready', assets: [], jobs: [job] };
}

describe('recording library polling policy', () => {
  it('keeps only a slow recovery poll while realtime events drive active updates', () => {
    expect(recordingPollDelay(ready({ ...baseJob, state: 'uploading' }))).toBe(60_000);
    expect(recordingPollDelay(ready(baseJob))).toBe(60_000);
  });

  it('uses the same recovery cadence while RabbitMQ is retrying an errored publication', () => {
    expect(recordingPollDelay(ready({ ...baseJob, error: 'Cuota agotada', retryAt: '2026-09-21T10:30:00.000Z' })))
      .toBe(60_000);
    expect(recordingPollDelay(ready({ ...baseJob, state: 'private_ready' }))).toBeNull();
    expect(recordingPollDelay(ready({ ...baseJob, state: 'reconciliation_failed' }))).toBeNull();
  });
});
