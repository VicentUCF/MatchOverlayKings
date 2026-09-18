import { describe, expect, it } from 'vitest';
import { addPoint, createInitialMatchState } from '@kpl/shared';
import type { MatchState, Team } from '@kpl/shared';
import type { EventSummary } from './kpl-data.js';
import { sortByCourt, toLiveCourtSummary } from './live-court-summary.js';

const teams: Team[] = [
  { id: 'kings', name: 'Kings of Favar', shortName: 'Kings', logoUrl: '/logos/kings.png', primaryColor: '#d1007a', secondaryColor: '#0f1115' },
  { id: 'lions', name: 'Red Lions', shortName: 'Lions', logoUrl: '/logos/lions.png', primaryColor: '#e21a23', secondaryColor: '#14151a' },
];

const teamById = new Map(teams.map((team) => [team.id, team]));

function baseState(): MatchState {
  return createInitialMatchState({
    id: 'pista-1',
    title: 'Kings of Favar vs Red Lions',
    homeTeamId: 'kings',
    awayTeamId: 'lions',
    lineups: { home: { player1: 'Ana', player2: 'Bea' }, away: { player1: 'Caro', player2: '' } },
    servingSide: 'home',
    courtName: 'Pista 1',
    status: 'live',
    config: { setsToWin: 2, gamesPerSet: 6, tieBreakAt: 6, tieBreakTarget: 7, tieBreakWinBy: 2, deuceMode: 'golden-point' },
  });
}

function event(state: MatchState, overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: state.id,
    title: state.title,
    courtName: state.courtName,
    homeTeamId: state.homeTeamId,
    awayTeamId: state.awayTeamId,
    status: 'live',
    version: state.version,
    updatedAt: state.updatedAt,
    state,
    youtubeWatchUrl: null,
    ...overrides,
  };
}

describe('live court summary', () => {
  it('reads the scoreboard a viewer needs before opening the match', () => {
    let state = baseState();
    state = addPoint(state, 'home', 'point-1');
    state = addPoint(state, 'away', 'point-2');
    state = addPoint(state, 'home', 'point-3');

    const summary = toLiveCourtSummary(
      event(state, { youtubeWatchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
      teamById,
    );

    expect(summary.courtName).toBe('Pista 1');
    expect(summary.setLabel).toBe('Set 1');
    expect(summary.home.name).toBe('Kings');
    expect(summary.home.point).toBe('30');
    expect(summary.away.point).toBe('15');
    expect(summary.home.serving).toBe(true);
    expect(summary.home.leading).toBe(false);
    expect(summary.watchUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(summary.scoreboardUrl).toBe('/live/pista-1');
  });

  it('keeps only the players the operator has entered', () => {
    const summary = toLiveCourtSummary(event(baseState()), teamById);

    expect(summary.home.players).toEqual(['Ana', 'Bea']);
    expect(summary.away.players).toEqual(['Caro']);
  });

  it('falls back to the team id when the catalog has no team', () => {
    const summary = toLiveCourtSummary(event(baseState()), new Map());

    expect(summary.home.name).toBe('kings');
    expect(summary.home.logoUrl).toBeNull();
  });

  it('announces the point that decides a set', () => {
    let state = baseState();
    for (let game = 0; game < 5; game += 1) {
      for (let point = 0; point < 4; point += 1) state = addPoint(state, 'home', `game-${game}-${point}`);
    }
    for (let point = 0; point < 3; point += 1) state = addPoint(state, 'home', `set-point-${point}`);

    expect(toLiveCourtSummary(event(state), teamById).highlight).toBe('Punto de set · Kings');
  });

  it('counts games and sets already won', () => {
    let state = baseState();
    for (let game = 0; game < 6; game += 1) {
      for (let point = 0; point < 4; point += 1) state = addPoint(state, 'home', `won-${game}-${point}`);
    }

    const summary = toLiveCourtSummary(event(state), teamById);

    expect(summary.home.sets).toBe(1);
    expect(summary.home.leading).toBe(true);
    expect(summary.setLabel).toBe('Set 2');
  });

  it('keeps a stable court order so a live card never moves under a viewer', () => {
    const first = toLiveCourtSummary(event(baseState()), teamById);
    const second = { ...first, id: 'pista-2', highlight: 'Punto de partido · Lions' };
    const tenth = { ...first, id: 'pista-10' };

    expect(sortByCourt([tenth, second, first]).map((summary) => summary.id))
      .toEqual(['pista-1', 'pista-2', 'pista-10']);
  });
});
