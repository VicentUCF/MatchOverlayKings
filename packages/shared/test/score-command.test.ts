import { describe, expect, it } from 'vitest';
import { applyMatchAction, createInitialMatchState, replayMatchActions } from '../src/index.js';

function initial() {
  return createInitialMatchState({
    id: 'postproduction-test', title: 'Partido', homeTeamId: 'home', awayTeamId: 'away',
    lineups: { home: { player1: 'A', player2: 'B' }, away: { player1: 'C', player2: 'D' } },
    servingSide: 'home', courtName: 'Pista 1', status: 'live',
    config: { setsToWin: 2, gamesPerSet: 6, tieBreakAt: 6, tieBreakTarget: 7, tieBreakWinBy: 2, deuceMode: 'golden-point' },
  });
}

describe('postproduction score command replay', () => {
  it('replays timestamp-independent actions deterministically', () => {
    const actions = [0, 1, 2, 3].map((index) => ({ id: `point-${index}`, kind: 'add_point' as const, payload: { side: 'home' } }));
    const state = replayMatchActions(initial(), actions);
    expect(state.sets[0]?.homeGames).toBe(1);
    expect(state.currentGame.homePoints).toBe(0);
    expect(state.version).toBe(5);
  });

  it('supports visual commands without a Supabase scoreboard', () => {
    const state = applyMatchAction(initial(), {
      id: 'overlay-1', kind: 'update_overlay', payload: { patch: { visible: false, position: 'bottom-center' } },
    });
    expect(state.overlaySettings).toMatchObject({ visible: false, position: 'bottom-center' });
  });
});
