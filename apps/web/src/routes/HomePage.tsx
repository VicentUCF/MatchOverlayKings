import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { BarChart3, RefreshCw, WifiOff, Youtube, Zap } from 'lucide-react';
import type { Team } from '@kpl/shared';
import { type EventSummary, fetchEventSummaries, fetchTeams, subscribeToScoreStates } from '../lib/kpl-data.js';
import { type LiveCourtSummary, type LiveCourtTeam, sortByCourt, toLiveCourtSummary } from '../lib/live-court-summary.js';

type LoadState = 'loading' | 'ready' | 'error';

export function HomePage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);

  const teamById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const liveCourts = useMemo(
    () => sortByCourt(
      events
        .filter((event) => event.status === 'live')
        .map((event) => toLiveCourtSummary(event, teamById)),
    ),
    [events, teamById],
  );

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
    <main className="home-page live-home">
      <header className="home-topbar">
        <div className="brand">
          <img src="/logos/kpl-wordmark.png" alt="" />
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

      <section className="live-hero" aria-labelledby="live-home-title">
        <p className="live-kicker">
          <span className="live-dot" aria-hidden="true" />
          En directo ahora
        </p>
        <h1 id="live-home-title">{heroTitle(loadState, liveCourts.length)}</h1>
        <p className="live-hero-lead">
          Mira el partido en YouTube y sigue el marcador punto a punto sin salir de la pista.
        </p>
      </section>

      <section className="live-court-section" aria-label="Pistas en directo">
        {loadState === 'loading' ? <div className="loading-panel">Buscando pistas en directo</div> : null}

        {loadState === 'error' ? (
          <div className="empty-panel">
            <WifiOff size={20} />
            <span>{error}</span>
          </div>
        ) : null}

        {loadState === 'ready' && liveCourts.length === 0 ? (
          <div className="empty-panel live-empty">
            <strong>Ahora mismo no hay ninguna pista en directo.</strong>
            <span>Esta pagina se actualiza sola en cuanto empiece el siguiente partido.</span>
          </div>
        ) : null}

        {liveCourts.length > 0 ? (
          <div className="live-court-grid">
            {liveCourts.map((court) => (
              <LiveCourtCard key={court.id} court={court} />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function LiveCourtCard({ court }: { court: LiveCourtSummary }) {
  return (
    <article className="live-court-card" style={courtColors(court)}>
      <header className="live-court-head">
        <span className="live-court-pill">
          <span className="live-dot" aria-hidden="true" />
          En directo
        </span>
        <h2>{court.courtName}</h2>
        <span className="live-court-set">{court.setLabel}</span>
      </header>

      <div className="live-court-score">
        <div className="live-score-legend" aria-hidden="true">
          <span />
          <span>Sets</span>
          <span>Juegos</span>
          <span>Punto</span>
        </div>
        <LiveTeamRow team={court.home} />
        <LiveTeamRow team={court.away} />
      </div>

      {court.highlight ? (
        <p className="live-court-highlight">
          <Zap size={15} aria-hidden="true" />
          {court.highlight}
        </p>
      ) : null}

      <div className="live-court-actions">
        {court.watchUrl ? (
          <>
            <a
              className="live-cta primary"
              href={court.watchUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Youtube size={20} aria-hidden="true" />
              Ver en YouTube
            </a>
            <a className="live-cta" href={court.scoreboardUrl}>
              <BarChart3 size={18} aria-hidden="true" />
              Marcador en directo
            </a>
          </>
        ) : (
          <>
            <a className="live-cta primary" href={court.scoreboardUrl}>
              <BarChart3 size={20} aria-hidden="true" />
              Marcador en directo
            </a>
            <p className="live-cta-note">El video de esta pista todavia no esta disponible.</p>
          </>
        )}
      </div>
    </article>
  );
}

function LiveTeamRow({ team }: { team: LiveCourtTeam }) {
  return (
    <div className={`live-team-row ${team.leading ? 'leading' : ''}`} style={{ '--team-color': team.color } as CSSProperties}>
      <span className="live-team-identity">
        <span className="team-badge-logo">
          {team.logoUrl ? <img src={team.logoUrl} alt="" /> : teamInitials(team.name)}
        </span>
        <span className="live-team-names">
          <strong>{team.name}</strong>
          {team.players.length > 0 ? <small>{team.players.join(' · ')}</small> : null}
        </span>
        {team.serving ? <span className="live-serve-dot" title="Al saque" aria-label="Al saque" /> : null}
      </span>

      {/* Remounting on a new value replays the pop animation, so a scored point is impossible to miss. */}
      <b className="live-score-value" key={`sets-${team.sets}`}>{team.sets}</b>
      <b className="live-score-value" key={`games-${team.games}`}>{team.games}</b>
      <strong className="live-score-value live-point" key={`point-${team.point}`}>{team.point}</strong>
    </div>
  );
}

function courtColors(court: LiveCourtSummary): CSSProperties {
  return {
    '--home-color': court.home.color,
    '--away-color': court.away.color,
  } as CSSProperties;
}

function heroTitle(loadState: LoadState, liveCount: number): string {
  if (loadState !== 'ready') {
    return 'Kings Padel League';
  }

  if (liveCount === 0) {
    return 'Sin partidos en juego';
  }

  return liveCount === 1 ? '1 pista en juego' : `${liveCount} pistas en juego`;
}

function teamInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
