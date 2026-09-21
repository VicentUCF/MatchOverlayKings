import { useEffect, useState } from 'react';
import type { MatchState, Team } from '@kpl/shared';
import { OverlayScene } from './OverlayPage.js';
import type { LeagueSnapshot } from '../lib/league-data.js';

export function PostproductionOverlayPage({ projectId }: { readonly projectId: string }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [snapshot, setSnapshot] = useState<{ state: MatchState; teams: Team[]; leagueSnapshot: LeagueSnapshot | null; confirmedAt: number } | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(`/api/pilot/postproduction/projects/${encodeURIComponent(projectId)}/render-state?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Render state unavailable');
        const next = await response.json() as { state: MatchState; teams: Team[]; leagueSnapshot: LeagueSnapshot | null; confirmedAt: number };
        if (active) setSnapshot(next);
      } catch { /* The renderer health loop owns retries and operator feedback. */ }
      finally { pending = false; }
    };
    void load();
    const interval = window.setInterval(() => void load(), 40);
    return () => { active = false; window.clearInterval(interval); };
  }, [projectId, token]);

  return <div data-pilot-match-ready={snapshot ? 'true' : 'false'} data-pilot-confirmed-at={snapshot?.confirmedAt ?? ''}>
    <OverlayScene match={{ state: snapshot?.state ?? null, teams: snapshot?.teams ?? [], leagueSnapshot: snapshot?.leagueSnapshot ?? null }} />
  </div>;
}
