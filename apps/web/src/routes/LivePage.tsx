import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, Wifi, WifiOff } from 'lucide-react';
import { animate, stagger } from 'animejs';
import { formatPoint, getCompletedSetCount } from '@kpl/shared';
import type { MatchSetScore, MatchState, Side, Team } from '@kpl/shared';
import { CardAnnouncementScene } from '../components/CardAnnouncementScene.js';
import { Scoreboard } from '../components/Scoreboard.js';
import { useCardAnnouncementQueue } from '../hooks/useCardAnnouncementQueue.js';
import {
  type LeaguePlayer,
  type LeaguePlayerRanking,
  type LeagueSnapshot,
  type LeagueStanding,
  type LeagueTeam,
  fetchLeagueSnapshot,
} from '../lib/league-data.js';
import { SPONSORS, resolveSponsors } from '../lib/sponsors.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';

export function LivePage({ eventId }: { eventId: string }) {
  const match = useMatchSocket(eventId, 'viewer', '');
  const stageRef = useRef<HTMLElement>(null);
  const viewportStyle = useVisualViewportStyle();
  const [leagueSnapshot, setLeagueSnapshot] = useState<LeagueSnapshot | null>(null);
  const [leagueError, setLeagueError] = useState<string | null>(null);
  const { activeAnnouncement, completeAnnouncement } = useCardAnnouncementQueue(
    match.state?.cards?.announcement ?? null,
    match.state?.status === 'live',
  );

  useEffect(() => {
    if (match.teams.length === 0) {
      return undefined;
    }

    let cancelled = false;
    setLeagueSnapshot(null);
    setLeagueError(null);

    void fetchLeagueSnapshot(match.teams)
      .then((snapshot) => {
        if (!cancelled) {
          setLeagueSnapshot(snapshot);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLeagueError(error instanceof Error ? error.message : 'No se pudieron cargar los datos de liga.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [match.teams]);

  useEffect(() => {
    if (!stageRef.current || prefersReducedMotion()) {
      return undefined;
    }

    const animation = animate(stageRef.current.querySelectorAll('.watch-score-shell, .watch-state-panel'), {
      opacity: [{ from: 0, to: 1 }],
      y: [{ from: 10, to: 0 }],
      delay: stagger(35),
      duration: 280,
      ease: 'outCubic',
    });

    return () => {
      animation.revert();
    };
  }, [eventId, match.state?.status]);

  return (
    <main className="watch-page" style={viewportStyle}>
      <header className="watch-topbar">
        <div className="brand">
          <img src="/logos/kpl-wordmark.png" alt="" />
          <span>
            <strong>KPL Live</strong>
            <small>{eventId}</small>
          </span>
        </div>

        <div className="watch-topbar-actions">
          <a className="match-action" href="/">
            <ArrowLeft size={18} />
            Directos
          </a>
          <div className={`connection-pill ${match.connectionState}`}>
            {match.connectionState === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>{connectionLabel(match.connectionState)}</span>
          </div>
        </div>
      </header>

      <section className="watch-layout watch-stage" ref={stageRef}>
        {match.state?.status === 'live' ? (
          <section className="watch-score-shell" aria-label="Marcador en directo">
            <div className="watch-scoreboard-view">
              <div className="watch-desktop-layout">
                <section className="watch-primary-score">
                  <div className="broadcast-scoreboard-shell overlay-page">
                    <Scoreboard state={match.state} teams={match.teams} mode="overlay" />
                  </div>
                </section>
                <DesktopMatchDashboard
                  state={match.state}
                  teams={match.teams}
                  snapshot={leagueSnapshot}
                  error={leagueError}
                />
              </div>
            </div>
            <WatchMobileScoreView state={match.state} teams={match.teams} />
          </section>
        ) : null}
        {match.state && match.state.status !== 'live' ? (
          <div className="watch-state-panel empty-panel">Este partido no esta en directo.</div>
        ) : null}
        {!match.state && match.connectionState === 'connecting' ? (
          <div className="watch-state-panel loading-panel">Cargando marcador</div>
        ) : null}
        {!match.state && match.connectionState !== 'connecting' ? (
          <div className="watch-state-panel empty-panel">Este partido no esta en directo.</div>
        ) : null}
      </section>

      {activeAnnouncement ? (
        <CardAnnouncementScene
          announcement={activeAnnouncement}
          teams={match.teams}
          onDone={completeAnnouncement}
        />
      ) : null}
    </main>
  );
}

function DesktopMatchDashboard({
  state,
  teams,
  snapshot,
  error,
}: {
  state: MatchState;
  teams: Team[];
  snapshot: LeagueSnapshot | null;
  error: string | null;
}) {
  const dashboardRef = useRef<HTMLElement>(null);
  const home = teams.find((team) => team.id === state.homeTeamId);
  const away = teams.find((team) => team.id === state.awayTeamId);
  const homeLeagueTeam = useMemo(
    () => resolveDashboardTeam(snapshot, teams, state.homeTeamId),
    [snapshot, state.homeTeamId, teams],
  );
  const awayLeagueTeam = useMemo(
    () => resolveDashboardTeam(snapshot, teams, state.awayTeamId),
    [snapshot, state.awayTeamId, teams],
  );
  const playerCards = useMemo(
    () => [
      ...createPlayerCards('home', state, snapshot, homeLeagueTeam, home),
      ...createPlayerCards('away', state, snapshot, awayLeagueTeam, away),
    ],
    [away, awayLeagueTeam, home, homeLeagueTeam, snapshot, state],
  );
  const standingRows = useMemo(
    () => selectStandingRows(snapshot, state.homeTeamId, state.awayTeamId),
    [snapshot, state.awayTeamId, state.homeTeamId],
  );
  const sponsorIds = state.sponsorAds.ticker.sponsorIds.length > 0
    ? state.sponsorAds.ticker.sponsorIds
    : SPONSORS.map((sponsor) => sponsor.id);
  const sponsors = resolveSponsors([...new Set(sponsorIds)]).slice(0, 6);

  useEffect(() => {
    if (!dashboardRef.current || prefersReducedMotion()) {
      return undefined;
    }

    const animation = animate(
      dashboardRef.current.querySelectorAll('.watch-dashboard-section'),
      {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 10, to: 0 }],
        delay: stagger(45),
        duration: 260,
        ease: 'outCubic',
      },
    );

    return () => {
      animation.revert();
    };
  }, [error, snapshot?.loadedAt]);

  return (
    <aside className="watch-desktop-dashboard" aria-label="Datos del partido" ref={dashboardRef}>
      <section className="watch-dashboard-section watch-player-section">
        <header className="watch-section-heading">
          <span>Jugadores</span>
          <strong>Ranking de pista</strong>
        </header>
        {error ? <WatchDataMessage title="Datos no disponibles" detail={error} /> : null}
        {!error && !snapshot ? <WatchDataMessage title="Cargando jugadores" detail="Ranking y plantillas KPL" /> : null}
        {!error && snapshot && playerCards.length === 0 ? (
          <WatchDataMessage title="Sin jugadores" detail="Aun no hay alineacion disponible." />
        ) : null}
        {!error && playerCards.length > 0 ? (
          <div className="watch-player-grid">
            {playerCards.map((player) => (
              <article
                className={`watch-player-card ${player.side}`}
                key={player.id}
                style={{ '--team-color': player.color } as CSSProperties}
              >
                <span className="watch-player-photo">
                  {player.photoUrl ? <img src={player.photoUrl} alt="" /> : teamInitials(player.name)}
                </span>
                <span>
                  <small>{player.roleLabel}</small>
                  <strong>{player.name}</strong>
                </span>
                <em>{player.rank ? `#${player.rank}` : '-'}</em>
                <b>{player.points !== null ? `${player.points} pts` : 'Ranking'}</b>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <section className="watch-dashboard-section watch-standings-section">
        <header className="watch-section-heading">
          <span>Liga</span>
          <strong>Clasificacion</strong>
        </header>
        {!snapshot && !error ? <WatchDataMessage title="Cargando tabla" detail="Clasificacion de equipos" /> : null}
        {snapshot ? (
          <div className="watch-standing-table" role="table" aria-label="Clasificacion de liga">
            {standingRows.map((standing) => (
              <div
                className={`watch-standing-row ${isMatchTeam(standing, state) ? 'featured' : ''}`}
                key={standing.externalTeamId ?? standing.localTeamId ?? standing.teamName}
                style={{ '--team-color': standing.primaryColor } as CSSProperties}
                role="row"
              >
                <strong>#{standing.rank}</strong>
                <span>{standing.logoUrl ? <img src={standing.logoUrl} alt="" /> : standing.shortName.slice(0, 2)}</span>
                <b>{standing.shortName}</b>
                <small>{standing.wonMatches}G</small>
                <small>{standing.lostMatches}P</small>
                <em>{standing.points} pts</em>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="watch-dashboard-section watch-sponsor-section">
        <header className="watch-section-heading">
          <span>KPL</span>
          <strong>Patrocinadores</strong>
        </header>
        <div className="watch-sponsor-strip">
          {sponsors.map((sponsor) => (
            <article
              className="watch-sponsor-chip"
              key={sponsor.id}
              style={{ '--sponsor-color': sponsor.accentColor } as CSSProperties}
            >
              {sponsor.logoUrl ? <img src={sponsor.logoUrl} alt="" /> : <span>{teamInitials(sponsor.name)}</span>}
              <strong>{sponsor.name}</strong>
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
}

function WatchMobileScoreView({ state, teams }: { state: MatchState; teams: Team[] }) {
  const cardRef = useRef<HTMLElement>(null);
  const home = teams.find((team) => team.id === state.homeTeamId);
  const away = teams.find((team) => team.id === state.awayTeamId);
  const activeSet = getVisibleActiveSet(state);
  const servingTeam = state.servingSide === 'home' ? home : away;
  const homeName = home?.shortName ?? 'Equipo A';
  const awayName = away?.shortName ?? 'Equipo B';
  const scoreValues: Record<string, string> = {
    'home-points': state.status === 'finished' ? '-' : formatPoint(state, 'home'),
    'away-points': state.status === 'finished' ? '-' : formatPoint(state, 'away'),
    'home-games': String(activeSet?.homeGames ?? 0),
    'away-games': String(activeSet?.awayGames ?? 0),
    'home-sets': String(getCompletedSetCount(state, 'home')),
    'away-sets': String(getCompletedSetCount(state, 'away')),
    serve: servingTeam?.shortName ?? sideLabel(state.servingSide),
  };

  useWatchScoreAnimation(cardRef, scoreValues, 1.035);

  return (
    <section
      className="watch-mobile-score-card"
      aria-label="Marcador en directo"
      ref={cardRef}
      style={mobileScoreTeamStyle(home, away, servingTeam)}
    >
      <header className="mobile-score-header">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span className={`mobile-live-pill ${state.status}`}>{statusLabel(state.status)}</span>
      </header>

      <div className="mobile-score-title watch-mobile-title">
        <span />
        <strong>{state.title || 'Marcador del partido'}</strong>
        <span />
      </div>

      <div className="mobile-team-score-grid watch-mobile-team-score-grid">
        <WatchMobileTeamBlock team={home} fallback={homeName} side="home" />
        <div className="mobile-versus" aria-hidden="true">
          VS
        </div>
        <WatchMobileTeamBlock team={away} fallback={awayName} side="away" />
        <strong className="mobile-point-value home" data-watch-score-key="home-points">
          {scoreValues['home-points']}
        </strong>
        <strong className="mobile-point-value away" data-watch-score-key="away-points">
          {scoreValues['away-points']}
        </strong>
      </div>

      <dl className="mobile-score-stats watch-mobile-score-stats">
        <div>
          <dt>Juegos</dt>
          <dd>
            <span className="home" data-watch-score-key="home-games">
              {activeSet?.homeGames ?? 0}
            </span>
            <span>-</span>
            <span className="away" data-watch-score-key="away-games">
              {activeSet?.awayGames ?? 0}
            </span>
          </dd>
        </div>
        <div>
          <dt>Sets</dt>
          <dd>
            <span className="home" data-watch-score-key="home-sets">
              {getCompletedSetCount(state, 'home')}
            </span>
            <span>-</span>
            <span className="away" data-watch-score-key="away-sets">
              {getCompletedSetCount(state, 'away')}
            </span>
          </dd>
        </div>
        <div>
          <dt>Saque</dt>
          <dd className="serve-stat" data-watch-score-key="serve">
            <span className="mobile-ball" />
            <span>{scoreValues.serve}</span>
          </dd>
        </div>
        <div>
          <dt>Pista</dt>
          <dd>{state.courtName || statusLabel(state.status)}</dd>
        </div>
      </dl>

      <footer className="watch-mobile-set-strip set-strip" aria-label="Sets">
        {state.sets.slice(0, 3).map((set, index) => (
          <span key={`${index}-${set.status}`} className={set.status}>
            S{index + 1} {set.homeGames}-{set.awayGames}
            {set.tieBreak ? ` (${set.tieBreak.homePoints}-${set.tieBreak.awayPoints})` : ''}
          </span>
        ))}
      </footer>
    </section>
  );
}

function WatchMobileTeamBlock({
  team,
  fallback,
  side,
}: {
  team: Team | undefined;
  fallback: string;
  side: Side;
}) {
  return (
    <div className={`mobile-team-block ${side}`}>
      <span className="mobile-team-logo">
        {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : teamInitials(fallback)}
      </span>
      <strong>{fallback}</strong>
    </div>
  );
}

function mobileScoreTeamStyle(home: Team | undefined, away: Team | undefined, servingTeam: Team | undefined): CSSProperties {
  return {
    '--mobile-home-color': home?.primaryColor ?? '#c9a227',
    '--mobile-home-secondary': home?.secondaryColor ?? '#0d1016',
    '--mobile-away-color': away?.primaryColor ?? '#34d8ff',
    '--mobile-away-secondary': away?.secondaryColor ?? '#0d1016',
    '--mobile-serve-color': servingTeam?.primaryColor ?? '#c9a227',
  } as CSSProperties;
}

interface WatchPlayerCard {
  id: string;
  side: Side;
  name: string;
  roleLabel: string;
  photoUrl: string | null;
  rank: number | null;
  points: number | null;
  color: string;
}

function useWatchScoreAnimation(
  ref: { current: HTMLElement | null },
  scoreValues: Record<string, string>,
  scaleFrom: number,
): void {
  const previousScoreValuesRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    if (!ref.current || prefersReducedMotion()) {
      previousScoreValuesRef.current = scoreValues;
      return;
    }

    const previousScoreValues = previousScoreValuesRef.current;
    previousScoreValuesRef.current = scoreValues;

    if (!previousScoreValues) {
      return;
    }

    const changedKeys = Object.entries(scoreValues)
      .filter(([key, value]) => previousScoreValues[key] !== value)
      .map(([key]) => key);

    if (changedKeys.length === 0) {
      return;
    }

    const changedCells = changedKeys
      .map((key) => ref.current?.querySelector(`[data-watch-score-key="${key}"]`))
      .filter((cell): cell is Element => Boolean(cell));

    const animation = animate(changedCells, {
      opacity: [{ from: 0.62, to: 1 }],
      scale: [{ from: scaleFrom, to: 1 }],
      duration: 220,
      ease: 'outCubic',
    });

    return () => {
      animation.revert();
    };
  });
}

function useVisualViewportStyle(): CSSProperties {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const updateHeight = () => {
      setHeight(Math.floor(window.visualViewport?.height ?? window.innerHeight));
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    window.visualViewport?.addEventListener('resize', updateHeight);
    window.visualViewport?.addEventListener('scroll', updateHeight);

    return () => {
      window.removeEventListener('resize', updateHeight);
      window.visualViewport?.removeEventListener('resize', updateHeight);
      window.visualViewport?.removeEventListener('scroll', updateHeight);
    };
  }, []);

  return useMemo(
    () => height ? ({ '--watch-viewport-height': `${height}px` } as CSSProperties) : {},
    [height],
  );
}

function resolveDashboardTeam(
  snapshot: LeagueSnapshot | null,
  teams: Team[],
  localTeamId: string,
): LeagueTeam | null {
  const leagueTeam = snapshot?.teams.find((team) => team.localTeamId === localTeamId);

  if (leagueTeam) {
    return leagueTeam;
  }

  const localTeam = teams.find((team) => team.id === localTeamId);

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

function createPlayerCards(
  side: Side,
  state: MatchState,
  snapshot: LeagueSnapshot | null,
  leagueTeam: LeagueTeam | null,
  localTeam: Team | undefined,
): WatchPlayerCard[] {
  const lineup = state.lineups[side];
  const localTeamId = leagueTeam?.localTeamId ?? localTeam?.id ?? null;
  const lineupEntries = [
    { name: lineup.player1, playerId: lineup.player1Id },
    { name: lineup.player2, playerId: lineup.player2Id },
  ].filter((entry) => entry.name.trim().length > 0 || entry.playerId);
  const sourcePlayers = lineupEntries.length > 0
    ? lineupEntries
    : (leagueTeam?.players ?? [])
      .filter((player) => !player.isPresident)
      .slice(0, 2)
      .map((player) => ({ name: player.displayName, playerId: player.id }));

  return sourcePlayers.slice(0, 2).map(({ name, playerId }, index) => {
    const rankedPlayer = playerId
      ? snapshot?.playerRanking.find((player) => player.id === playerId) ?? null
      : findRankedPlayer(name, snapshot, localTeamId);
    const rosterPlayer = rankedPlayer
      ?? (playerId ? leagueTeam?.players.find((player) => player.id === playerId) : undefined)
      ?? findRosterPlayer(name, leagueTeam?.players ?? []);
    const displayName = rosterPlayer?.displayName ?? name;

    return {
      id: `${side}-${rosterPlayer?.id ?? (normalizePersonName(name) || String(index))}`,
      side,
      name: displayName,
      roleLabel: rosterPlayer?.isPresident ? 'Presidencia' : rosterPlayer?.roleLabel ?? sideLabel(side),
      photoUrl: rosterPlayer?.photoUrl ?? null,
      rank: rankedPlayer?.rank ?? null,
      points: rankedPlayer?.totalPoints ?? null,
      color: leagueTeam?.primaryColor ?? localTeam?.primaryColor ?? '#c9a227',
    };
  });
}

function findRankedPlayer(
  name: string,
  snapshot: LeagueSnapshot | null,
  localTeamId: string | null,
): LeaguePlayerRanking | null {
  if (!snapshot) {
    return null;
  }

  const target = normalizePersonName(name);
  const candidates = snapshot.playerRanking.filter((player) => !localTeamId || player.teamId === localTeamId);

  return (
    candidates.find((player) => normalizePersonName(player.alias ?? '') === target)
    ?? candidates.find((player) => normalizePersonName(player.displayName) === target)
    ?? candidates.find((player) => normalizePersonName(player.alias ?? '').includes(target))
    ?? candidates.find((player) => normalizePersonName(player.displayName).includes(target))
    ?? null
  );
}

function findRosterPlayer(name: string, players: LeaguePlayer[]): LeaguePlayer | null {
  const target = normalizePersonName(name);

  return (
    players.find((player) => normalizePersonName(player.alias ?? '') === target)
    ?? players.find((player) => normalizePersonName(player.displayName) === target)
    ?? players.find((player) => normalizePersonName(player.alias ?? '').includes(target))
    ?? players.find((player) => normalizePersonName(player.displayName).includes(target))
    ?? null
  );
}

function selectStandingRows(
  snapshot: LeagueSnapshot | null,
  homeTeamId: string,
  awayTeamId: string,
): LeagueStanding[] {
  if (!snapshot) {
    return [];
  }

  if (snapshot.standings.length <= 8) {
    return snapshot.standings;
  }

  const featuredTeamIds = new Set([homeTeamId, awayTeamId]);
  const rows = new Map<string, LeagueStanding>();

  for (const standing of snapshot.standings.slice(0, 4)) {
    rows.set(standing.externalTeamId ?? standing.localTeamId ?? standing.teamName, standing);
  }

  for (const standing of snapshot.standings) {
    if (standing.localTeamId && featuredTeamIds.has(standing.localTeamId)) {
      rows.set(standing.externalTeamId ?? standing.localTeamId ?? standing.teamName, standing);
    }
  }

  return [...rows.values()].sort((left, right) => left.rank - right.rank).slice(0, 8);
}

function isMatchTeam(standing: LeagueStanding, state: MatchState): boolean {
  return standing.localTeamId === state.homeTeamId || standing.localTeamId === state.awayTeamId;
}

function WatchDataMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="watch-data-message">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function getVisibleActiveSet(state: MatchState): MatchSetScore | null {
  return state.sets.find((set) => set.status === 'active') ?? state.sets.at(-1) ?? null;
}

function connectionLabel(state: string): string {
  return {
    connected: 'En directo',
    connecting: 'Conectando',
    disconnected: 'Sin conexion',
    error: 'Error',
  }[state] ?? state;
}

function sideLabel(side: Side): string {
  return side === 'home' ? 'Local' : 'Visitante';
}

function statusLabel(status: MatchState['status']): string {
  return {
    pre_match: 'Pre',
    live: 'En directo',
    finished: 'Final',
  }[status];
}

function teamInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function normalizePersonName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
