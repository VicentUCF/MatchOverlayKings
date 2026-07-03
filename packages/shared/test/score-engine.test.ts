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
  triggerOverlayDataScene,
  triggerSponsorFullscreen,
  undoLastScoringCommand,
  updateSponsorTicker,
  useMatchCard,
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

  it('allows one match card per side and clears cards on reset', () => {
    let state = createInitialMatchState(event);
    state = addPoint(state, 'home', 'go-live');
    state = useMatchCard(state, 'home', '2vs1', '2VS1', 'card-1');

    expect(state.cards.home?.cardId).toBe('2vs1');
    expect(state.cards.announcement?.cardName).toBe('2VS1');
    expect(() => useMatchCard(state, 'home', 'comodin', 'Comodin', 'card-2')).toThrow(
      'Ese equipo ya ha utilizado su carta.',
    );

    state = resetMatch(state, 'reset-after-card');

    expect(state.cards.home).toBeNull();
    expect(state.cards.announcement).toBeNull();
  });

  it('triggers overlay data scenes and clears them on reset', () => {
    let state = createInitialMatchState(event);

    expect(state.overlaySettings.dataScenesAuto).toBe(false);

    state = triggerOverlayDataScene(
      state,
      'team-roster',
      { type: 'side', side: 'home' },
      'data-scene-1',
    );

    expect(state.dataScene).toMatchObject({
      id: 'data-scene-1',
      kind: 'team-roster',
      target: { type: 'side', side: 'home' },
    });
    expect(state.history.at(-1)?.type).toBe('trigger_data_scene');

    state = resetMatch(state, 'reset-after-data-scene');

    expect(state.dataScene).toBeNull();
  });

  it('controls sponsor ads and keeps the ticker across resets', () => {
    let state = createInitialMatchState(event);
    state = updateSponsorTicker(
      state,
      {
        visible: true,
        sponsorIds: ['kpl', 'magic-city'],
        speedSeconds: 18,
      },
      'sponsor-ticker-1',
    );
    state = triggerSponsorFullscreen(state, ['kpl', 'magic-city'], 8, 'sponsor-fullscreen-1');

    expect(state.sponsorAds.ticker.visible).toBe(true);
    expect(state.sponsorAds.ticker.sponsorIds).toEqual(['kpl', 'magic-city']);
    expect(state.sponsorAds.fullscreen).toMatchObject({
      id: 'sponsor-fullscreen-1',
      sponsorIds: ['kpl', 'magic-city'],
      durationSeconds: 8,
    });

    state = resetMatch(state, 'reset-after-sponsor');

    expect(state.sponsorAds.ticker.visible).toBe(true);
    expect(state.sponsorAds.ticker.sponsorIds).toEqual(['kpl', 'magic-city']);
    expect(state.sponsorAds.fullscreen).toBeNull();
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
