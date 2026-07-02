import { describe, expect, it } from 'vitest';
import {
  addPoint,
  applyManualPatch,
  createInitialMatchState,
  formatPoint,
  getActiveSet,
  getCompletedSetCount,
  getPointContext,
  resetMatch,
  startNewMatch,
  undoLastScoringCommand,
} from '../src/index.js';
import type { EventDefinition, MatchState, Side } from '../src/index.js';

const event: Omit<EventDefinition, 'state'> = {
  id: 'test-match',
  title: 'Test match',
  homeTeamId: 'home',
  awayTeamId: 'away',
  lineups: {
    home: { player1: 'Home 1', player2: 'Home 2' },
    away: { player1: 'Away 1', player2: 'Away 2' },
  },
  servingSide: 'home',
  courtName: 'Central',
  status: 'pre_match',
  config: {
    setsToWin: 2,
    gamesPerSet: 6,
    tieBreakAt: 6,
    tieBreakTarget: 7,
    tieBreakWinBy: 2,
    deuceMode: 'golden-point',
  },
};

describe('score engine', () => {
  it('scores a normal golden-point game', () => {
    let state = createInitialMatchState(event);
    state = addPoints(state, 'home', 3);
    state = addPoints(state, 'away', 3);

    expect(formatPoint(state, 'home')).toBe('40');
    expect(formatPoint(state, 'away')).toBe('40');

    state = addPoint(state, 'home', 'golden-point');

    expect(getActiveSet(state).homeGames).toBe(1);
    expect(getActiveSet(state).awayGames).toBe(0);
    expect(formatPoint(state, 'home')).toBe('0');
  });

  it('closes a set at 6 games with two-game difference', () => {
    const state = winGames(createInitialMatchState(event), 'home', 6);

    expect(getCompletedSetCount(state, 'home')).toBe(1);
    expect(state.sets[0]?.status).toBe('complete');
    expect(state.sets[1]?.status).toBe('active');
  });

  it('plays a tie-break at 6-6 and closes it by two points', () => {
    let state = createInitialMatchState(event);

    for (let index = 0; index < 6; index += 1) {
      state = winGame(state, 'home');
      state = winGame(state, 'away');
    }

    expect(state.currentGame.isTieBreak).toBe(true);

    for (let index = 0; index < 6; index += 1) {
      state = addPoint(state, 'home', `tb-home-${index}`);
      state = addPoint(state, 'away', `tb-away-${index}`);
    }
    state = addPoint(state, 'home', 'tb-home-7');

    expect(state.currentGame.isTieBreak).toBe(true);

    state = addPoint(state, 'home', 'tb-final');

    expect(state.sets[0]?.homeGames).toBe(7);
    expect(state.sets[0]?.awayGames).toBe(6);
    expect(state.sets[0]?.tieBreak?.homePoints).toBe(8);
    expect(getCompletedSetCount(state, 'home')).toBe(1);
  });

  it('finishes the match at best of three sets', () => {
    let state = createInitialMatchState(event);
    state = winGames(state, 'home', 6);
    state = winGames(state, 'home', 6);

    expect(state.status).toBe('finished');
    expect(state.winner).toBe('home');
  });

  it('undoes the last scoring command', () => {
    let state = createInitialMatchState(event);
    state = addPoint(state, 'home', 'point-1');
    state = undoLastScoringCommand(state, 'undo-1');

    expect(formatPoint(state, 'home')).toBe('0');
    expect(state.version).toBe(3);
  });

  it('applies manual correction and reset', () => {
    let state = createInitialMatchState(event);
    state = applyManualPatch(
      state,
      {
        sets: [
          {
            homeGames: 3,
            awayGames: 2,
            status: 'active',
            winner: null,
            tieBreak: null,
          },
        ],
        currentGame: { homePoints: 2, awayPoints: 1, isTieBreak: false },
      },
      'manual-1',
    );

    expect(getActiveSet(state).homeGames).toBe(3);
    expect(formatPoint(state, 'home')).toBe('30');

    state = resetMatch(state, 'reset-1');

    expect(getActiveSet(state).homeGames).toBe(0);
    expect(state.status).toBe('pre_match');
  });

  it('starts a new match in the same court', () => {
    let state = createInitialMatchState(event);
    state = addPoint(state, 'home', 'point-1');
    state = startNewMatch(
      state,
      {
        title: 'Next match',
        courtName: 'Central',
        homeTeamId: 'away',
        awayTeamId: 'home',
        lineups: {
          home: { player1: 'A', player2: 'B' },
          away: { player1: 'C', player2: 'D' },
        },
        servingSide: 'away',
      },
      'new-match-1',
    );

    expect(state.id).toBe('test-match');
    expect(state.title).toBe('Next match');
    expect(state.status).toBe('pre_match');
    expect(state.currentGame.homePoints).toBe(0);
    expect(state.homeTeamId).toBe('away');
    expect(state.lineups.home.player1).toBe('A');
    expect(state.servingSide).toBe('away');
    expect(state.history).toHaveLength(1);
  });

  it('detects set point and match point', () => {
    let state = createInitialMatchState(event);
    state = winGames(state, 'home', 5);
    state = addPoints(state, 'home', 3);

    expect(getPointContext(state)).toEqual({ side: 'home', type: 'set_point' });

    state = addPoint(state, 'home', 'set-final');
    state = winGames(state, 'home', 5);
    state = addPoints(state, 'home', 3);

    expect(getPointContext(state)).toEqual({ side: 'home', type: 'match_point' });
  });
});

function addPoints(state: MatchState, side: Side, count: number): MatchState {
  let next = state;

  for (let index = 0; index < count; index += 1) {
    next = addPoint(next, side, `${side}-${next.version}-${index}`);
  }

  return next;
}

function winGame(state: MatchState, side: Side): MatchState {
  return addPoints(state, side, state.currentGame.isTieBreak ? 7 : 4);
}

function winGames(state: MatchState, side: Side, count: number): MatchState {
  let next = state;

  for (let index = 0; index < count; index += 1) {
    next = winGame(next, side);
  }

  return next;
}
