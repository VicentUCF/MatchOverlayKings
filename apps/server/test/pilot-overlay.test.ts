import { describe, expect, it } from 'vitest';
import { overlayUrl } from '../src/pilot-overlay.js';

describe('pilot browser overlay', () => {
  it('pins the streamed overlay to the configured team IDs', () => {
    expect(overlayUrl('http://127.0.0.1:4310', 'pista-1', { homeTeamId: 'kings-of-favar', awayTeamId: 'red-lions' }))
      .toBe('http://127.0.0.1:4310/overlay/pista-1/scoreboard?homeTeamId=kings-of-favar&awayTeamId=red-lions');
  });

  it('uses the same public scoreboard route configured in OBS', () => {
    expect(overlayUrl('http://127.0.0.1:4310/', 'pista-3'))
      .toBe('http://127.0.0.1:4310/overlay/pista-3/scoreboard');
  });
});
