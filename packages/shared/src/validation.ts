import type {
  EventDefinition,
  MatchCardId,
  MatchCardsState,
  MatchCardUse,
  MatchConfig,
  MatchLineups,
  MatchState,
  OverlaySettings,
  Side,
  SponsorAdsState,
  SponsorFullscreenState,
  SponsorTickerState,
  Team,
} from './types.js';

const DEFAULT_PARSED_OVERLAY_SETTINGS: OverlaySettings = {
  visible: true,
  size: 'standard',
  position: 'top-left',
  dataScenesAuto: false,
};
const DEFAULT_PARSED_SPONSOR_ADS: SponsorAdsState = {
  ticker: {
    visible: false,
    sponsorIds: [],
    label: 'Patrocinadores oficiales',
    speedSeconds: 28,
  },
  fullscreen: null,
};
const MATCH_CARD_IDS = ['2vs1', 'restas-tu', 'cambiate', 'robo-saque', 'solo-un-saque', 'comodin', 'robo-carta'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTeams(value: unknown): Team[] {
  if (!Array.isArray(value)) {
    throw new Error('teams.json debe ser un array.');
  }

  return value.map((item, index) => parseTeam(item, index));
}

export function parseEventDefinition(value: unknown): EventDefinition {
  if (!isRecord(value)) {
    throw new Error('El evento debe ser un objeto JSON.');
  }

  const event = {
    id: readString(value, 'id'),
    title: readString(value, 'title'),
    homeTeamId: readString(value, 'homeTeamId'),
    awayTeamId: readString(value, 'awayTeamId'),
    lineups: parseLineups(value.lineups),
    servingSide: readSide(value.servingSide, 'home'),
    courtName: readString(value, 'courtName'),
    status: readStatus(value.status),
    config: parseConfig(value.config),
    overlaySettings: parseOverlaySettings(value.overlaySettings),
    cards: parseMatchCards(value.cards),
    sponsorAds: parseSponsorAds(value.sponsorAds),
    state: value.state === null || value.state === undefined ? null : (value.state as MatchState),
  };

  return event;
}

export function parseLineups(value: unknown): MatchLineups {
  if (!isRecord(value)) {
    return createEmptyLineups();
  }

  return {
    home: parseLineup(value.home),
    away: parseLineup(value.away),
  };
}

export function createEmptyLineups(): MatchLineups {
  return {
    home: { player1: '', player2: '' },
    away: { player1: '', player2: '' },
  };
}

export function validateKnownTeams(event: EventDefinition, teams: Team[]): void {
  const ids = new Set(teams.map((team) => team.id));

  if (!ids.has(event.homeTeamId)) {
    throw new Error(`Equipo local desconocido: ${event.homeTeamId}`);
  }

  if (!ids.has(event.awayTeamId)) {
    throw new Error(`Equipo visitante desconocido: ${event.awayTeamId}`);
  }
}

function parseTeam(value: unknown, index: number): Team {
  if (!isRecord(value)) {
    throw new Error(`Equipo ${index + 1} invalido.`);
  }

  return {
    id: readString(value, 'id'),
    name: readString(value, 'name'),
    shortName: readString(value, 'shortName'),
    logoUrl: readString(value, 'logoUrl'),
    primaryColor: readString(value, 'primaryColor'),
    secondaryColor: readString(value, 'secondaryColor'),
  };
}

function parseConfig(value: unknown): MatchConfig {
  if (!isRecord(value)) {
    throw new Error('config debe ser un objeto.');
  }

  return {
    setsToWin: readNumber(value, 'setsToWin'),
    gamesPerSet: readNumber(value, 'gamesPerSet'),
    tieBreakAt: readNumber(value, 'tieBreakAt'),
    tieBreakTarget: readNumber(value, 'tieBreakTarget'),
    tieBreakWinBy: readNumber(value, 'tieBreakWinBy'),
    deuceMode: value.deuceMode === 'advantage' ? 'advantage' : 'golden-point',
  };
}

function parseLineup(value: unknown): MatchLineups['home'] {
  if (!isRecord(value)) {
    return { player1: '', player2: '' };
  }

  return {
    player1: readOptionalString(value, 'player1'),
    player2: readOptionalString(value, 'player2'),
  };
}

function parseOverlaySettings(value: unknown): OverlaySettings {
  if (!isRecord(value)) {
    return DEFAULT_PARSED_OVERLAY_SETTINGS;
  }

  const size = value.size === 'compact' || value.size === 'large' ? value.size : DEFAULT_PARSED_OVERLAY_SETTINGS.size;
  const position =
    value.position === 'center' || value.position === 'bottom-center'
      ? value.position
      : DEFAULT_PARSED_OVERLAY_SETTINGS.position;

  return {
    visible: typeof value.visible === 'boolean' ? value.visible : DEFAULT_PARSED_OVERLAY_SETTINGS.visible,
    size,
    position,
    dataScenesAuto:
      typeof value.dataScenesAuto === 'boolean' ? value.dataScenesAuto : DEFAULT_PARSED_OVERLAY_SETTINGS.dataScenesAuto,
  };
}

function parseMatchCards(value: unknown): MatchCardsState {
  if (!isRecord(value)) {
    return { home: null, away: null, announcement: null };
  }

  const announcement = parseCardUse(value.announcement);

  return {
    home: parseCardUse(value.home),
    away: parseCardUse(value.away),
    announcement: announcement && isRecord(value.announcement)
      ? {
          ...announcement,
          id: readOptionalString(value.announcement, 'id') || announcement.usedAt,
        }
      : null,
  };
}

function parseSponsorAds(value: unknown): SponsorAdsState {
  if (!isRecord(value)) {
    return cloneSponsorAds(DEFAULT_PARSED_SPONSOR_ADS);
  }

  return {
    ticker: parseSponsorTicker(value.ticker),
    fullscreen: parseSponsorFullscreen(value.fullscreen),
  };
}

function parseSponsorTicker(value: unknown): SponsorTickerState {
  if (!isRecord(value)) {
    return { ...DEFAULT_PARSED_SPONSOR_ADS.ticker };
  }

  return {
    visible: typeof value.visible === 'boolean' ? value.visible : DEFAULT_PARSED_SPONSOR_ADS.ticker.visible,
    sponsorIds: parseSponsorIds(value.sponsorIds),
    label: readOptionalString(value, 'label') || DEFAULT_PARSED_SPONSOR_ADS.ticker.label,
    speedSeconds: clampNumber(value.speedSeconds, 12, 90, DEFAULT_PARSED_SPONSOR_ADS.ticker.speedSeconds),
  };
}

function parseSponsorFullscreen(value: unknown): SponsorFullscreenState | null {
  if (!isRecord(value)) {
    return null;
  }

  const sponsorId = readOptionalString(value, 'sponsorId');

  if (!sponsorId) {
    return null;
  }

  const triggeredAt = readOptionalString(value, 'triggeredAt');

  return {
    id: readOptionalString(value, 'id') || triggeredAt || sponsorId,
    sponsorId,
    triggeredAt,
    durationSeconds: clampNumber(value.durationSeconds, 4, 30, 8),
  };
}

function parseSponsorIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function cloneSponsorAds(value: SponsorAdsState): SponsorAdsState {
  return {
    ticker: {
      ...value.ticker,
      sponsorIds: [...value.ticker.sponsorIds],
    },
    fullscreen: value.fullscreen ? { ...value.fullscreen } : null,
  };
}

function parseCardUse(value: unknown): MatchCardUse | null {
  if (!isRecord(value) || !isMatchCardId(value.cardId)) {
    return null;
  }

  return {
    side: readSide(value.side, 'home'),
    teamId: readOptionalString(value, 'teamId'),
    cardId: value.cardId,
    cardName: readOptionalString(value, 'cardName') || value.cardId,
    usedAt: readOptionalString(value, 'usedAt'),
  };
}

function isMatchCardId(value: unknown): value is MatchCardId {
  return MATCH_CARD_IDS.includes(value as MatchCardId);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo string requerido: ${key}`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  return typeof value === 'string' ? value.trim() : '';
}

function readSide(value: unknown, fallback: Side): Side {
  return value === 'away' ? 'away' : fallback;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Campo numerico requerido: ${key}`);
  }

  return value;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function readStatus(value: unknown): EventDefinition['status'] {
  if (value === 'pre_match' || value === 'live' || value === 'finished') {
    return value;
  }

  throw new Error('status invalido.');
}
