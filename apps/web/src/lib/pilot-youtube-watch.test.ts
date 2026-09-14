import { describe, expect, it } from 'vitest';
import type { PilotSession } from '@kpl/production-contracts';
import { youtubeWatchUrl } from './pilot-youtube-watch.js';

const session: PilotSession = {
  id: '11111111-1111-4111-8111-111111111111',
  courtSlug: 'pista-1',
  mode: 'youtube',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' },
  status: 'live',
  title: 'Kings vs Lions',
  description: 'Partido en directo',
  thumbnailUrl: '/thumbnail.png',
  broadcastId: 'broadcast-1',
  watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
  youtubeStreamStatus: 'active · good',
  encoder: null,
  startedAt: '2026-09-14T18:00:00.000Z',
  stoppedAt: null,
  error: null,
};

describe('youtube watch availability', () => {
  it.each(['starting', 'live', 'reconnecting', 'stopping'] as const)('exposes the URL while %s', (status) => {
    expect(youtubeWatchUrl({ ...session, status })).toBe(session.watchUrl);
  });

  it.each(['prepared', 'stopped', 'failed'] as const)('hides the URL while %s', (status) => {
    expect(youtubeWatchUrl({ ...session, status })).toBeNull();
  });

  it('does not expose a URL for simulated sessions', () => {
    expect(youtubeWatchUrl({ ...session, mode: 'simulation' })).toBeNull();
  });
});
