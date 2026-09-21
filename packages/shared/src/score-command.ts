import {
  addPoint,
  applyManualPatch,
  resetMatch,
  setMatchStatus,
  triggerOverlayDataScene,
  triggerSponsorFullscreen,
  undoLastScoringCommand,
  updateMatchMeta,
  updateOverlaySettings,
  updateSponsorTicker,
  useMatchCard,
} from './score-engine.js';
import type {
  ManualScorePatch, MatchCardId, MatchMetaPatch, MatchState, MatchStatus, OverlayDataSceneKind,
  OverlayDataSceneTarget, OverlaySettingsPatch, Side, SponsorTickerPatch,
} from './types.js';

export type MatchActionKind =
  | 'add_point' | 'undo' | 'reset' | 'manual_patch' | 'update_meta' | 'set_status'
  | 'update_overlay' | 'use_card' | 'trigger_data_scene' | 'update_sponsor_ticker' | 'trigger_sponsor_ad';

export interface MatchActionLike {
  readonly id: string;
  readonly kind: MatchActionKind;
  readonly payload: unknown;
}

export function applyMatchAction(state: MatchState, action: MatchActionLike): MatchState {
  const payload = objectPayload(action.payload);
  switch (action.kind) {
    case 'add_point': return addPoint(state, side(payload.side), action.id);
    case 'undo': return undoLastScoringCommand(state, action.id);
    case 'reset': return resetMatch(state, action.id);
    case 'manual_patch': return applyManualPatch(state, payload.patch as ManualScorePatch, action.id);
    case 'update_meta': return updateMatchMeta(state, payload.patch as MatchMetaPatch, action.id);
    case 'set_status': return setMatchStatus(state, status(payload.status), action.id);
    case 'update_overlay': return updateOverlaySettings(state, payload.patch as OverlaySettingsPatch, action.id);
    case 'use_card': return useMatchCard(state, side(payload.side), String(payload.cardId) as MatchCardId,
      String(payload.cardName ?? payload.cardId ?? ''), action.id);
    case 'trigger_data_scene': return triggerOverlayDataScene(state, String(payload.kind) as OverlayDataSceneKind,
      payload.target as OverlayDataSceneTarget, action.id);
    case 'update_sponsor_ticker': return updateSponsorTicker(state, payload.patch as SponsorTickerPatch, action.id);
    case 'trigger_sponsor_ad': return triggerSponsorFullscreen(state,
      payload.sponsorIds === null ? null : Array.isArray(payload.sponsorIds) ? payload.sponsorIds.map(String) : [],
      typeof payload.durationSeconds === 'number' ? payload.durationSeconds : undefined, action.id);
  }
}

export function replayMatchActions<T extends MatchActionLike>(initial: MatchState, actions: readonly T[]): MatchState {
  return actions.reduce((state, action) => applyMatchAction(state, action), initial);
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Payload de marcador no válido.');
  return value as Record<string, unknown>;
}

function side(value: unknown): Side {
  if (value !== 'home' && value !== 'away') throw new TypeError('Lado de marcador no válido.');
  return value;
}

function status(value: unknown): MatchStatus {
  if (value !== 'pre_match' && value !== 'live' && value !== 'finished') throw new TypeError('Estado de partido no válido.');
  return value;
}
