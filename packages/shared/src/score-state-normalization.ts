import { DEFAULT_OVERLAY_SETTINGS, DEFAULT_SPONSOR_ADS } from './score-defaults.js';
import type {
  MatchCardId,
  MatchCardsState,
  MatchCardUse,
  OverlayDataSceneKind,
  OverlayDataSceneState,
  OverlayDataSceneTarget,
  OverlaySettings,
  SponsorAdsState,
  SponsorFullscreenState,
  SponsorTickerState,
} from './types.js';

const MATCH_CARD_IDS = ['2vs1', 'restas-tu', 'cambiate', 'robo-saque', 'solo-un-saque', 'comodin', 'robo-carta'] as const;
const OVERLAY_DATA_SCENE_KINDS = [
  'standings', 'player-ranking', 'team-roster', 'calendar', 'upcoming-matches', 'latest-results',
] as const;

export function normalizeOverlaySettings(settings: Partial<OverlaySettings> | undefined): OverlaySettings {
  return {
    visible: typeof settings?.visible === 'boolean' ? settings.visible : DEFAULT_OVERLAY_SETTINGS.visible,
    size: isOverlaySize(settings?.size) ? settings.size : DEFAULT_OVERLAY_SETTINGS.size,
    position: isOverlayPosition(settings?.position) ? settings.position : DEFAULT_OVERLAY_SETTINGS.position,
    dataScenesAuto: typeof settings?.dataScenesAuto === 'boolean'
      ? settings.dataScenesAuto : DEFAULT_OVERLAY_SETTINGS.dataScenesAuto,
    soundEnabled: typeof settings?.soundEnabled === 'boolean'
      ? settings.soundEnabled : DEFAULT_OVERLAY_SETTINGS.soundEnabled,
    soundVolume: typeof settings?.soundVolume === 'number'
      ? clampNumber(settings.soundVolume, 0, 1, DEFAULT_OVERLAY_SETTINGS.soundVolume)
      : DEFAULT_OVERLAY_SETTINGS.soundVolume,
  };
}

export function normalizeMatchCards(cards: Partial<MatchCardsState> | undefined): MatchCardsState {
  const announcement = cloneCardUse(cards?.announcement);
  return {
    home: cloneCardUse(cards?.home),
    away: cloneCardUse(cards?.away),
    announcement: cards?.announcement && announcement
      ? { ...announcement, id: cards.announcement.id || cards.announcement.usedAt }
      : null,
  };
}

export function cloneMatchCards(cards: MatchCardsState | undefined): MatchCardsState {
  return normalizeMatchCards(cards);
}

export function cloneDataScene(scene: OverlayDataSceneState | null | undefined): OverlayDataSceneState | null {
  if (!scene || !isOverlayDataSceneKind(scene.kind)) return null;
  return {
    id: scene.id,
    kind: scene.kind,
    target: normalizeDataSceneTarget(scene.target),
    triggeredAt: scene.triggeredAt,
  };
}

export function normalizeSponsorAds(ads: Partial<SponsorAdsState> | undefined): SponsorAdsState {
  return {
    ticker: normalizeSponsorTicker(ads?.ticker),
    fullscreen: normalizeSponsorFullscreen(ads?.fullscreen),
  };
}

export function normalizeSponsorTicker(ticker: Partial<SponsorTickerState> | undefined): SponsorTickerState {
  return {
    visible: typeof ticker?.visible === 'boolean' ? ticker.visible : DEFAULT_SPONSOR_ADS.ticker.visible,
    sponsorIds: normalizeSponsorIds(ticker?.sponsorIds),
    label: ticker?.label?.trim() || DEFAULT_SPONSOR_ADS.ticker.label,
    speedSeconds: normalizeTickerSpeed(ticker?.speedSeconds),
  };
}

export function cloneSponsorAds(ads: SponsorAdsState | undefined): SponsorAdsState {
  return normalizeSponsorAds(ads);
}

export function clearSponsorFullscreen(ads: SponsorAdsState | undefined): SponsorAdsState {
  return { ...normalizeSponsorAds(ads), fullscreen: null };
}

export function normalizeSponsorIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function normalizeSponsorDuration(value: unknown): number {
  return normalizeNumber(value, 4, 30, 8);
}

export function normalizeDataSceneTarget(target: unknown): OverlayDataSceneTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return { type: 'league' };
  const record = target as Record<string, unknown>;
  if (record.type === 'side') return { type: 'side', side: record.side === 'away' ? 'away' : 'home' };
  if (record.type === 'team' && typeof record.teamId === 'string' && record.teamId.trim()) {
    return { type: 'team', teamId: record.teamId.trim() };
  }
  return { type: 'league' };
}

export function isMatchCardId(value: unknown): value is MatchCardId {
  return MATCH_CARD_IDS.includes(value as MatchCardId);
}

export function isOverlayDataSceneKind(value: unknown): value is OverlayDataSceneKind {
  return OVERLAY_DATA_SCENE_KINDS.includes(value as OverlayDataSceneKind);
}

function cloneCardUse(cardUse: MatchCardUse | null | undefined): MatchCardUse | null {
  if (!cardUse || !isMatchCardId(cardUse.cardId)) return null;
  return {
    side: cardUse.side === 'away' ? 'away' : 'home',
    teamId: cardUse.teamId,
    cardId: cardUse.cardId,
    cardName: cardUse.cardName,
    usedAt: cardUse.usedAt,
  };
}

function normalizeSponsorFullscreen(
  fullscreen: (SponsorFullscreenState & { sponsorId?: string }) | null | undefined,
): SponsorFullscreenState | null {
  if (!fullscreen) return null;
  const sponsorIds = normalizeSponsorIds(fullscreen.sponsorIds);
  const legacySponsorId = typeof fullscreen.sponsorId === 'string' ? fullscreen.sponsorId.trim() : '';
  const normalizedSponsorIds = sponsorIds.length > 0 ? sponsorIds : legacySponsorId ? [legacySponsorId] : [];
  if (normalizedSponsorIds.length === 0) return null;
  return {
    id: fullscreen.id || normalizedSponsorIds.join('-'),
    sponsorIds: normalizedSponsorIds,
    triggeredAt: fullscreen.triggeredAt,
    durationSeconds: normalizeSponsorDuration(fullscreen.durationSeconds),
  };
}

function normalizeTickerSpeed(value: unknown): number {
  return normalizeNumber(value, 12, 90, DEFAULT_SPONSOR_ADS.ticker.speedSeconds);
}

function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isOverlaySize(value: unknown): value is OverlaySettings['size'] {
  return value === 'compact' || value === 'standard' || value === 'large';
}

function isOverlayPosition(value: unknown): value is OverlaySettings['position'] {
  return value === 'top-left' || value === 'center' || value === 'bottom-center';
}
