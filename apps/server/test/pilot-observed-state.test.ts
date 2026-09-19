import { describe, expect, it } from 'vitest';
import { PilotSessionSchema } from '@kpl/production-contracts';
import { observeYouTubeSession } from '../src/pilot-observed-state.js';

const session = PilotSessionSchema.parse({
  id: '123e4567-e89b-42d3-a456-426614174000', courtSlug: 'pista-1', mode: 'youtube',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' }, status: 'starting',
  title: 'Kings vs Lions', description: 'Partido', thumbnailUrl: '/thumbnail',
  broadcastId: 'broadcast-1', watchUrl: 'https://youtube.com/watch?v=broadcast-1',
  youtubeStreamStatus: null, encoder: null, startedAt: null, stoppedAt: null, error: null,
});

describe('observed destination state', () => {
  it.each(['ready', 'created', 'testing', 'liveStarting', null])('does not label active ingest as live while broadcast is %s', (broadcastStatus) => {
    expect(observeYouTubeSession(session, { broadcastStatus, streamStatus: 'active', healthStatus: 'good' }, true).status).toBe('starting');
  });
  it('requires both a live broadcast and active ingest', () => {
    expect(observeYouTubeSession(session, { broadcastStatus: 'live', streamStatus: 'active', healthStatus: 'good' }, true).status).toBe('live');
    expect(observeYouTubeSession(session, { broadcastStatus: 'live', streamStatus: 'inactive', healthStatus: 'bad' }, true).status).toBe('starting');
  });
  it('does not undo an operator stop while a remote health request is in flight', () => {
    expect(observeYouTubeSession({ ...session, status: 'stopping' }, { broadcastStatus: 'live', streamStatus: 'active', healthStatus: 'good' }, true).status).toBe('stopping');
  });
  it('reconciles remote live and completed sessions after a runtime restart', () => {
    const interrupted = observeYouTubeSession(session, { broadcastStatus: 'live', streamStatus: 'active', healthStatus: 'good' }, false);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.error).toContain('YouTube mantiene');
    expect(observeYouTubeSession(interrupted, { broadcastStatus: 'complete', streamStatus: 'inactive', healthStatus: 'good' }, false).status).toBe('stopped');
  });
});
