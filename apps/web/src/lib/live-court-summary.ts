import { formatPoint, getCompletedSetCount, getPointContext } from '@kpl/shared';
import type { MatchSetScore, MatchState, Side, Team } from '@kpl/shared';
import type { EventSummary } from './kpl-data.js';

export interface LiveCourtTeam {
  readonly id: string;
  readonly side: Side;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly color: string;
  readonly players: readonly string[];
  readonly serving: boolean;
  readonly leading: boolean;
  readonly sets: number;
  readonly games: number;
  readonly point: string;
}

export interface LiveCourtSummary {
  readonly id: string;
  readonly courtName: string;
  readonly title: string;
  readonly home: LiveCourtTeam;
  readonly away: LiveCourtTeam;
  readonly setLabel: string;
  /** The reason to watch right now, when there is one. */
  readonly highlight: string | null;
  readonly watchUrl: string | null;
  readonly scoreboardUrl: string;
}

export function toLiveCourtSummary(event: EventSummary, teamById: Map<string, Team>): LiveCourtSummary {
  const state = event.state;
  const activeSet = visibleActiveSet(state);
  const home = toLiveCourtTeam('home', event, state, activeSet, teamById);
  const away = toLiveCourtTeam('away', event, state, activeSet, teamById);

  return {
    id: event.id,
    courtName: event.courtName || state.courtName,
    title: event.title || state.title,
    home,
    away,
    setLabel: `Set ${state.sets.length}`,
    highlight: highlightLabel(state, home, away),
    watchUrl: event.youtubeWatchUrl,
    scoreboardUrl: `/live/${event.id}`,
  };
}

/**
 * Courts keep a fixed order across refreshes: a card that reorders under a viewer
 * who is reaching for its button would send them to the wrong match.
 */
export function sortByCourt(summaries: readonly LiveCourtSummary[]): LiveCourtSummary[] {
  return [...summaries].sort((left, right) => left.id.localeCompare(right.id, 'es', { numeric: true }));
}

function toLiveCourtTeam(
  side: Side,
  event: EventSummary,
  state: MatchState,
  activeSet: MatchSetScore | null,
  teamById: Map<string, Team>,
): LiveCourtTeam {
  const teamId = side === 'home' ? event.homeTeamId : event.awayTeamId;
  const team = teamById.get(teamId);
  const lineup = state.lineups[side];
  const sets = getCompletedSetCount(state, side);
  const games = side === 'home' ? activeSet?.homeGames ?? 0 : activeSet?.awayGames ?? 0;
  const opponentSets = getCompletedSetCount(state, side === 'home' ? 'away' : 'home');
  const opponentGames = side === 'home' ? activeSet?.awayGames ?? 0 : activeSet?.homeGames ?? 0;

  return {
    id: teamId,
    side,
    name: team?.shortName ?? teamId,
    logoUrl: team?.logoUrl ?? null,
    color: team?.primaryColor ?? '#c9a227',
    players: [lineup.player1, lineup.player2].filter((player) => player.trim().length > 0),
    serving: state.servingSide === side,
    leading: sets > opponentSets || (sets === opponentSets && games > opponentGames),
    sets,
    games,
    point: formatPoint(state, side),
  };
}

function highlightLabel(state: MatchState, home: LiveCourtTeam, away: LiveCourtTeam): string | null {
  const context = getPointContext(state);

  if (context !== null) {
    const team = context.side === 'home' ? home : away;
    return `${context.type === 'match_point' ? 'Punto de partido' : 'Punto de set'} · ${team.name}`;
  }

  return state.currentGame.isTieBreak ? 'Tie-break' : null;
}

function visibleActiveSet(state: MatchState): MatchSetScore | null {
  return state.sets.find((set) => set.status === 'active') ?? state.sets.at(-1) ?? null;
}
