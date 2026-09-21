import { PilotSessionSchema, type PilotSession } from '@kpl/production-contracts';
import type { PilotYouTubeHealth } from './pilot-youtube.js';

/** The destination confirms public live state; ingest activity alone does not. */
export function observeYouTubeSession(session: PilotSession, health: PilotYouTubeHealth, hasProcess: boolean): PilotSession {
  const terminal = health.broadcastStatus === 'complete' || health.broadcastStatus === 'revoked';
  const running = ['starting', 'live', 'reconnecting'].includes(session.status);
  let status = session.status;
  let error = session.error;
  if (terminal && !hasProcess) { status = 'stopped'; error = null; }
  else if (terminal && running) {
    status = 'failed';
    error = 'YouTube ha cerrado esta emisión. Finaliza la sesión local antes de preparar otra.';
  } else if (running && hasProcess) {
    status = health.broadcastStatus === 'live' && health.streamStatus === 'active' ? 'live' : 'starting';
  } else if (health.broadcastStatus === 'live' && !hasProcess && !['stopping', 'failed'].includes(status)) {
    status = 'interrupted';
    error = 'YouTube mantiene el directo activo, pero este runtime no tiene el encoder. Recupera o finaliza esta misma emisión.';
  }
  return PilotSessionSchema.parse({
    ...session, status, error,
    stoppedAt: status === 'stopped' ? session.stoppedAt ?? new Date().toISOString() : session.stoppedAt,
    youtubeStreamStatus: [health.broadcastStatus, health.streamStatus, health.healthStatus].filter(Boolean).join(' · ') || 'Sin estado confirmado',
  });
}
