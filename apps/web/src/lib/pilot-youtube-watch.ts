import type { PilotSession } from '@kpl/production-contracts';

const WATCHABLE_STATUSES: ReadonlySet<PilotSession['status']> = new Set([
  'starting',
  'live',
  'reconnecting',
  'stopping',
]);

export function youtubeWatchUrl(session: PilotSession | null): string | null {
  if (session?.mode !== 'youtube' || session.watchUrl === null || !WATCHABLE_STATUSES.has(session.status)) {
    return null;
  }

  return session.watchUrl;
}
