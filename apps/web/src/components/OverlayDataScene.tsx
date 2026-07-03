import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { animate, stagger } from 'animejs';
import type { MatchState, OverlayDataSceneState, Team } from '@kpl/shared';
import {
  type LeagueMatch,
  type LeagueSnapshot,
  type LeagueTeam,
  fetchLeagueSnapshot,
} from '../lib/league-data.js';

export function OverlayDataScene({
  scene,
  state,
  teams,
  onDone,
}: {
  scene: OverlayDataSceneState;
  state: MatchState;
  teams: Team[];
  onDone: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<LeagueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const featuredTeam = useMemo(() => resolveTeam(scene, state, teams, snapshot), [scene, snapshot, state, teams]);
  const sceneStyle = {
    '--scene-color': featuredTeam?.primaryColor ?? '#c9a227',
  } as CSSProperties;

  useEffect(() => {
    let cancelled = false;

    setSnapshot(null);
    setError(null);

    void fetchLeagueSnapshot(teams)
      .then((nextSnapshot) => {
        if (!cancelled) {
          setSnapshot(nextSnapshot);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los datos.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [scene.id, teams]);

  useEffect(() => {
    if (!snapshot && !error) {
      return undefined;
    }

    const timeoutId = window.setTimeout(onDone, prefersReducedMotion() ? 6_000 : 7_000);

    if (!ref.current || prefersReducedMotion()) {
      return () => window.clearTimeout(timeoutId);
    }

    const sceneElement = ref.current;
    const animations = [
      animate(sceneElement, {
        opacity: [{ from: 0, to: 1 }],
        duration: 240,
        ease: 'outCubic',
      }),
      animate(sceneElement.querySelectorAll('.data-scene-brand, .data-scene-title, .data-scene-footer'), {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 16, to: 0 }],
        delay: stagger(70, { start: 120 }),
        duration: 420,
        ease: 'outCubic',
      }),
      animate(sceneElement.querySelectorAll('.data-scene-row, .data-roster-card, .data-match-card, .data-matchday-card'), {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 18, to: 0 }],
        scale: [{ from: 0.98, to: 1 }],
        delay: stagger(54, { start: 240 }),
        duration: 420,
        ease: 'outExpo',
      }),
      animate(sceneElement.querySelectorAll('.data-scene-sweep'), {
        opacity: [{ from: 0, to: 0.88 }, { to: 0.2 }],
        x: [{ from: '-24vw', to: '22vw' }],
        delay: stagger(140, { start: 160 }),
        duration: 1_250,
        ease: 'outCubic',
      }),
    ];

    return () => {
      window.clearTimeout(timeoutId);
      animations.forEach((animation) => animation.revert());
    };
  }, [error, onDone, snapshot]);

  return (
    <section
      className="overlay-data-scene"
      data-overlay-data-scene
      data-scene-kind={scene.kind}
      ref={ref}
      style={sceneStyle}
      aria-label={sceneTitle(scene.kind)}
    >
      <div className="data-scene-bg" />
      <span className="data-scene-sweep one" aria-hidden="true" />
      <span className="data-scene-sweep two" aria-hidden="true" />
      <span className="data-scene-sweep three" aria-hidden="true" />

      <div className="data-scene-brand">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span>Datos oficiales</span>
      </div>

      <div className="data-scene-title">
        <span>{sceneEyebrow(scene.kind, featuredTeam)}</span>
        <strong>{sceneTitle(scene.kind, featuredTeam)}</strong>
      </div>

      <div className="data-scene-content">
        {error ? <DataSceneError message={error} /> : null}
        {!error && !snapshot ? <DataSceneLoading /> : null}
        {!error && snapshot ? renderSceneContent(scene, snapshot, featuredTeam) : null}
      </div>

      <div className="data-scene-footer">
        <span>kingspadelleague.es</span>
        <strong>{state.courtName || state.title}</strong>
      </div>
    </section>
  );
}

function renderSceneContent(
  scene: OverlayDataSceneState,
  snapshot: LeagueSnapshot,
  featuredTeam: LeagueTeam | null,
): ReactNode {
  if (scene.kind === 'standings') {
    return (
      <div className="data-standings-table">
        {snapshot.standings.map((standing) => (
          <div className="data-scene-row" key={standing.externalTeamId ?? standing.localTeamId}>
            <strong>#{standing.rank}</strong>
            <span className="data-team-badge" style={{ '--team-color': standing.primaryColor } as CSSProperties}>
              {standing.logoUrl ? <img src={standing.logoUrl} alt="" /> : standing.shortName.slice(0, 2)}
            </span>
            <b>{standing.teamName}</b>
            <small>{standing.playedMatches} J</small>
            <small>{standing.wonMatches} G</small>
            <small>{standing.lostMatches} P</small>
            <em>{standing.points} pts</em>
          </div>
        ))}
      </div>
    );
  }

  if (scene.kind === 'player-ranking') {
    return (
      <div className="data-player-ranking">
        {snapshot.playerRanking.slice(0, 10).map((player) => (
          <div className="data-scene-row" key={player.id}>
            <strong>#{player.rank}</strong>
            <span className="data-player-photo">
              {player.photoUrl ? <img src={player.photoUrl} alt="" /> : initials(player.displayName)}
            </span>
            <b>{player.displayName}</b>
            <small>{player.teamName}</small>
            <em>{player.totalPoints} pts</em>
          </div>
        ))}
      </div>
    );
  }

  if (scene.kind === 'team-roster') {
    return <RosterScene team={featuredTeam} />;
  }

  if (scene.kind === 'calendar') {
    return (
      <div className="data-matchday-grid">
        {snapshot.matchdays.slice(0, 5).map((matchday) => (
          <article className="data-matchday-card" key={matchday.id}>
            <span>{matchday.dateLabel}</span>
            <strong>{matchday.name}</strong>
            <small>{statusLabel(matchday.status)}</small>
          </article>
        ))}
      </div>
    );
  }

  const matches = scene.kind === 'latest-results' ? snapshot.latestResults : snapshot.upcomingMatches;

  return (
    <div className="data-match-grid">
      {(matches.length > 0 ? matches : snapshot.calendarMatches.slice(0, 4)).slice(0, 6).map((match) => (
        <MatchCard key={match.id} match={match} showResult={scene.kind === 'latest-results'} />
      ))}
    </div>
  );
}

function RosterScene({ team }: { team: LeagueTeam | null }) {
  if (!team) {
    return (
      <div className="data-scene-empty">
        <strong>Equipo no encontrado</strong>
        <span>No hay datos disponibles para esta plantilla.</span>
      </div>
    );
  }

  if (team.dataStatus === 'pending') {
    return (
      <div className="data-roster-pending">
        <span className="data-roster-logo">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : team.shortName.slice(0, 2)}</span>
        <div>
          <strong>{team.name}</strong>
          <span>Datos pendientes en el catalogo oficial</span>
        </div>
      </div>
    );
  }

  return (
    <div className="data-roster-layout">
      <aside className="data-roster-summary">
        <span className="data-roster-logo">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : team.shortName.slice(0, 2)}</span>
        <strong>{team.name}</strong>
        <small>{team.standing ? `#${team.standing.rank} - ${team.standing.points} pts` : 'Clasificacion pendiente'}</small>
        <small>{team.presidentName ? `Presidencia: ${team.presidentName}` : `${team.players.length} jugadores`}</small>
      </aside>
      <div className="data-roster-grid">
        {team.players.slice(0, 12).map((player) => (
          <article className="data-roster-card" key={player.id}>
            <span className="data-player-photo">
              {player.photoUrl ? <img src={player.photoUrl} alt="" /> : initials(player.displayName)}
            </span>
            <div>
              <small>{player.isPresident ? 'Presidencia' : player.roleLabel}</small>
              <strong>{player.alias ?? player.displayName}</strong>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function MatchCard({ match, showResult }: { match: LeagueMatch; showResult: boolean }) {
  return (
    <article className="data-match-card">
      <span>{match.matchdayName}</span>
      <strong>
        {match.homeTeamName} <em>vs</em> {match.awayTeamName}
      </strong>
      <div>
        <small>{match.scheduledAtLabel}</small>
        <b>{showResult ? `${match.homeScore}-${match.awayScore}` : statusLabel(match.status)}</b>
      </div>
      {match.pairResults.length > 0 ? (
        <p>{match.pairResults.slice(0, 2).map((pair) => `${pair.label}: ${pair.homeScoreLabel}-${pair.awayScoreLabel}`).join(' · ')}</p>
      ) : null}
    </article>
  );
}

function DataSceneLoading() {
  return <div className="data-scene-empty">Cargando datos KPL</div>;
}

function DataSceneError({ message }: { message: string }) {
  return (
    <div className="data-scene-empty">
      <strong>No se pudieron cargar los datos</strong>
      <span>{message}</span>
    </div>
  );
}

function resolveTeam(
  scene: OverlayDataSceneState,
  state: MatchState,
  localTeams: Team[],
  snapshot: LeagueSnapshot | null,
): LeagueTeam | null {
  const targetTeamId = scene.target.type === 'side'
    ? scene.target.side === 'home' ? state.homeTeamId : state.awayTeamId
    : scene.target.type === 'team' ? scene.target.teamId : null;

  if (!targetTeamId) {
    return null;
  }

  const leagueTeam = snapshot?.teams.find((team) => team.localTeamId === targetTeamId);

  if (leagueTeam) {
    return leagueTeam;
  }

  const localTeam = localTeams.find((team) => team.id === targetTeamId);

  if (!localTeam) {
    return null;
  }

  return {
    externalId: null,
    localTeamId: localTeam.id,
    name: localTeam.name,
    shortName: localTeam.shortName,
    logoUrl: localTeam.logoUrl,
    primaryColor: localTeam.primaryColor,
    players: [],
    presidentName: null,
    standing: null,
    dataStatus: 'pending',
  };
}

function sceneEyebrow(kind: OverlayDataSceneState['kind'], team: LeagueTeam | null): string {
  if (kind === 'team-roster') {
    return team?.shortName ?? 'Plantilla';
  }

  return 'KingsPadelLeague';
}

function sceneTitle(kind: OverlayDataSceneState['kind'], team?: LeagueTeam | null): string {
  return {
    standings: 'Clasificacion de la liga',
    'player-ranking': 'Ranking de jugadores',
    'team-roster': team?.name ?? 'Plantilla del equipo',
    calendar: 'Calendario de jornadas',
    'upcoming-matches': 'Proximos partidos',
    'latest-results': 'Ultimos resultados',
  }[kind];
}

function statusLabel(status: LeagueMatch['status']): string {
  return {
    scheduled: 'Programado',
    in_progress: 'En juego',
    finished: 'Finalizado',
  }[status];
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
