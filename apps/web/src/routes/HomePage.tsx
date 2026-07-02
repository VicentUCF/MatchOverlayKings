import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Eye, RefreshCw, WifiOff } from 'lucide-react';
import type { MatchState, Team } from '@kpl/shared';
import { type EventSummary, fetchEventSummaries, fetchTeams, subscribeToScoreStates } from '../lib/kpl-data.js';

type LoadState = 'loading' | 'ready' | 'error';

export function HomePage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);

  const teamById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const liveEvents = useMemo(() => events.filter((event) => event.status === 'live'), [events]);

  const loadEvents = useCallback(async (silent = false) => {
    if (!silent) {
      setLoadState('loading');
      setError(null);
    }

    try {
      const [eventsPayload, teamsPayload] = await Promise.all([
        fetchEventSummaries({ liveOnly: true }),
        fetchTeams(),
      ]);

      setEvents(eventsPayload);
      setTeams(teamsPayload);
      setError(null);
      setLoadState('ready');
    } catch (loadError) {
      if (silent) {
        return;
      }

      setError(loadError instanceof Error ? loadError.message : 'Error desconocido.');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = subscribeToScoreStates(() => {
        void loadEvents(true);
      });
    } catch {
      unsubscribe = null;
    }

    const intervalId = window.setInterval(() => {
      void loadEvents(true);
    }, 10_000);

    return () => {
      unsubscribe?.();
      window.clearInterval(intervalId);
    };
  }, [loadEvents]);

  return (
    <main className="home-page">
      <header className="home-topbar">
        <div className="brand">
          <img src="/logos/kpl.png" alt="" />
          <span>
            <strong>KPL Live</strong>
            <small>Resultados en directo</small>
          </span>
        </div>

        <button type="button" className="refresh-button" onClick={() => void loadEvents()} disabled={loadState === 'loading'}>
          <RefreshCw size={18} />
          Actualizar
        </button>
      </header>

      <section className="match-picker" aria-labelledby="match-picker-title">
        <div className="section-heading">
          <h1 id="match-picker-title">Partidos en directo</h1>
          <span>{liveEvents.length} activos</span>
        </div>

        {loadState === 'loading' ? <div className="loading-panel">Cargando partidos</div> : null}

        {loadState === 'error' ? (
          <div className="empty-panel">
            <WifiOff size={20} />
            <span>{error}</span>
          </div>
        ) : null}

        {loadState === 'ready' && liveEvents.length === 0 ? (
          <div className="empty-panel">No hay partidos en directo.</div>
        ) : null}

        {loadState === 'ready' && liveEvents.length > 0 ? (
          <div className="match-list">
            {liveEvents.map((event) => (
              <MatchRow
                key={event.id}
                event={event}
                homeTeam={teamById.get(event.homeTeamId)}
                awayTeam={teamById.get(event.awayTeamId)}
              />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function MatchRow({
  event,
  homeTeam,
  awayTeam,
}: {
  event: EventSummary;
  homeTeam: Team | undefined;
  awayTeam: Team | undefined;
}) {
  return (
    <article className="match-row">
      <div className="match-info">
        <span className={`match-status ${event.status}`}>{statusLabel(event.status)}</span>
        <h2>{event.courtName}</h2>
        <p>{event.title}</p>
        <div className="match-teams">
          <TeamBadge team={homeTeam} fallback={event.homeTeamId} />
          <span className="versus">vs</span>
          <TeamBadge team={awayTeam} fallback={event.awayTeamId} />
        </div>
        <small>
          Ruta {event.id} - Version {event.version}
        </small>
      </div>

      <div className="match-actions">
        <a className="match-action primary" href={`/live/${event.id}`}>
          <Eye size={18} />
          Ver directo
        </a>
      </div>
    </article>
  );
}

function TeamBadge({ team, fallback }: { team: Team | undefined; fallback: string }) {
  return (
    <span className="team-badge">
      <span className="team-badge-logo" style={{ '--team-color': team?.primaryColor } as CSSProperties}>
        {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : fallback.slice(0, 2)}
      </span>
      <strong>{team?.shortName ?? fallback}</strong>
    </span>
  );
}

function statusLabel(status: MatchState['status']): string {
  return {
    pre_match: 'Pre',
    live: 'Live',
    finished: 'Final',
  }[status];
}
