import type { MatchCardsState, MatchConfig, OverlaySettings, SponsorAdsState } from './types.js';

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  setsToWin: 2,
  gamesPerSet: 6,
  tieBreakAt: 6,
  tieBreakTarget: 7,
  tieBreakWinBy: 2,
  deuceMode: 'golden-point',
};

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  visible: true,
  size: 'standard',
  position: 'top-left',
  dataScenesAuto: false,
  soundEnabled: false,
  soundVolume: 0.55,
};

export const DEFAULT_MATCH_CARDS: MatchCardsState = {
  home: null,
  away: null,
  announcement: null,
};

export const DEFAULT_SPONSOR_ADS: SponsorAdsState = {
  ticker: {
    visible: false,
    sponsorIds: [],
    label: 'Patrocinadores oficiales',
    speedSeconds: 28,
  },
  fullscreen: null,
};
