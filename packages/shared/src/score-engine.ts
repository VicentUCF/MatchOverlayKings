import type {
  EventDefinition,
  ManualScorePatch,
  MatchCardId,
  MatchCardsState,
  MatchCardUse,
  MatchConfig,
  MatchGameScore,
  MatchHistoryEntry,
  MatchLineups,
  MatchMetaPatch,
  OverlayDataSceneKind,
  OverlayDataSceneState,
  OverlayDataSceneTarget,
  OverlaySettings,
  OverlaySettingsPatch,
  MatchSetScore,
  MatchState,
  MatchStatus,
  NewMatchSetup,
  ScoreSnapshot,
  Side,
} from './types.js';
import { createEmptyLineups } from './validation.js';

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
};

export const DEFAULT_MATCH_CARDS: MatchCardsState = {
  home: null,
  away: null,
  announcement: null,
};

const POINT_LABELS = ['0', '15', '30', '40'] as const;
const MATCH_CARD_IDS = ['2vs1', 'restas-tu', 'cambiate', 'robo-saque', 'solo-un-saque', 'comodin', 'robo-carta'] as const;
const OVERLAY_DATA_SCENE_KINDS = [
  'standings',
  'player-ranking',
  'team-roster',
  'calendar',
  'upcoming-matches',
  'latest-results',
] as const;

export class ScoreEngineError extends Error {
  constructor(
    readonly code:
      | 'MATCH_FINISHED'
      | 'VALIDATION_ERROR',
    message: string,
  ) {
    super(message);
  }
}

export function createInitialMatchState(event: Omit<EventDefinition, 'state'>): MatchState {
  const now = new Date().toISOString();

  return {
    id: event.id,
    title: event.title,
    homeTeamId: event.homeTeamId,
    awayTeamId: event.awayTeamId,
    lineups: cloneLineups(event.lineups),
    servingSide: event.servingSide,
    courtName: event.courtName,
    status: event.status,
    config: { ...DEFAULT_MATCH_CONFIG, ...event.config },
    sets: [createActiveSet()],
    currentGame: createGame(false),
    winner: null,
    overlaySettings: normalizeOverlaySettings(event.overlaySettings),
    cards: normalizeMatchCards(event.cards),
    dataScene: null,
    history: [],
    version: 1,
    updatedAt: now,
  };
}

export function ensureMatchState(event: EventDefinition): MatchState {
  return normalizeMatchState(event.state ?? createInitialMatchState(event), event);
}

export function addPoint(state: MatchState, side: Side, commandId: string): MatchState {
  if (state.status === 'finished' || state.winner) {
    throw new ScoreEngineError('MATCH_FINISHED', 'El partido ya esta finalizado.');
  }

  return mutateWithHistory(state, commandId, 'add_point', side, `Punto ${sideLabel(side)}`, (draft) => {
    draft.status = 'live';

    if (draft.currentGame.isTieBreak) {
      addTieBreakPoint(draft, side);
      return;
    }

    draft.currentGame = {
      ...draft.currentGame,
      [`${side}Points`]: draft.currentGame[`${side}Points`] + 1,
    };

    if (isGameComplete(draft.currentGame, draft.config)) {
      awardGame(draft, side);
    }
  });
}

export function undoLastScoringCommand(state: MatchState, commandId: string): MatchState {
  const lastUndoable = [...state.history]
    .reverse()
    .find((entry) => ['add_point', 'manual_patch', 'reset'].includes(entry.type));

  if (!lastUndoable) {
    return mutateWithHistory(state, commandId, 'undo', null, 'Undo sin cambios', () => undefined);
  }

  return mutateWithHistory(state, commandId, 'undo', lastUndoable.side, 'Deshacer ultima accion', (draft) => {
    applySnapshot(draft, lastUndoable.before);
  });
}

export function resetMatch(state: MatchState, commandId: string): MatchState {
  return mutateWithHistory(state, commandId, 'reset', null, 'Reiniciar marcador', (draft) => {
    draft.status = 'pre_match';
    draft.sets = [createActiveSet()];
    draft.currentGame = createGame(false);
    draft.winner = null;
    draft.cards = cloneMatchCards(DEFAULT_MATCH_CARDS);
    draft.dataScene = null;
  });
}

export function startNewMatch(
  state: MatchState,
  setup: NewMatchSetup,
  commandId: string,
): MatchState {
  const before = getScoreSnapshot(state);
  const draft = cloneState(state);

  applyMetaPatch(draft, setup);
  draft.status = 'pre_match';
  draft.sets = [createActiveSet()];
  draft.currentGame = createGame(false);
  draft.winner = null;
  draft.cards = cloneMatchCards(DEFAULT_MATCH_CARDS);
  draft.dataScene = null;

  const after = getScoreSnapshot(draft);
  const now = new Date().toISOString();
  const entry: MatchHistoryEntry = {
    id: `${draft.id}-${draft.version + 1}-new_match`,
    commandId,
    type: 'new_match',
    side: null,
    label: 'Nueva partida',
    before,
    after,
    createdAt: now,
  };

  return {
    ...draft,
    history: [entry],
    version: draft.version + 1,
    updatedAt: now,
  };
}

export function applyManualPatch(
  state: MatchState,
  patch: ManualScorePatch,
  commandId: string,
): MatchState {
  return mutateWithHistory(state, commandId, 'manual_patch', null, 'Correccion manual', (draft) => {
    if (patch.status) {
      draft.status = patch.status;
    }

    if (patch.sets) {
      draft.sets = cloneSets(patch.sets);
    }

    if (patch.currentGame) {
      draft.currentGame = { ...patch.currentGame };
    }

    if (patch.winner !== undefined) {
      draft.winner = patch.winner;
    }

    validateMatchShape(draft);
  });
}

export function updateMatchMeta(
  state: MatchState,
  patch: MatchMetaPatch,
  commandId: string,
): MatchState {
  return mutateWithHistory(state, commandId, 'update_meta', null, 'Actualizar partido', (draft) => {
    applyMetaPatch(draft, patch);
  });
}

export function updateOverlaySettings(
  state: MatchState,
  patch: OverlaySettingsPatch,
  commandId: string,
): MatchState {
  return mutateWithHistory(state, commandId, 'update_overlay', null, 'Actualizar OBS', (draft) => {
    draft.overlaySettings = normalizeOverlaySettings({
      ...draft.overlaySettings,
      ...patch,
    });
  });
}

export function useMatchCard(
  state: MatchState,
  side: Side,
  cardId: MatchCardId,
  cardName: string,
  commandId: string,
): MatchState {
  if (state.status !== 'live') {
    throw new ScoreEngineError('VALIDATION_ERROR', 'Las cartas solo se pueden lanzar con el partido en directo.');
  }

  if (!isMatchCardId(cardId)) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'Carta no valida.');
  }

  if (state.cards?.[side]) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'Ese equipo ya ha utilizado su carta.');
  }

  return mutateWithHistory(state, commandId, 'use_card', side, `Carta ${sideLabel(side)}`, (draft) => {
    const usedAt = new Date().toISOString();
    const use: MatchCardUse = {
      side,
      teamId: side === 'home' ? draft.homeTeamId : draft.awayTeamId,
      cardId,
      cardName: cardName.trim() || cardId,
      usedAt,
    };

    draft.cards = {
      ...normalizeMatchCards(draft.cards),
      [side]: use,
      announcement: {
        ...use,
        id: commandId,
      },
    };
  });
}

export function triggerOverlayDataScene(
  state: MatchState,
  kind: OverlayDataSceneKind,
  target: OverlayDataSceneTarget,
  commandId: string,
): MatchState {
  if (!isOverlayDataSceneKind(kind)) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'Escena de datos no valida.');
  }

  return mutateWithHistory(state, commandId, 'trigger_data_scene', null, dataSceneLabel(kind), (draft) => {
    draft.dataScene = {
      id: commandId,
      kind,
      target: normalizeDataSceneTarget(target),
      triggeredAt: new Date().toISOString(),
    };
  });
}

export function setMatchStatus(
  state: MatchState,
  status: MatchStatus,
  commandId: string,
): MatchState {
  return mutateWithHistory(state, commandId, 'set_status', null, `Estado ${status}`, (draft) => {
    draft.status = status;

    if (status !== 'finished') {
      draft.winner = null;
    }
  });
}

export function formatPoint(state: MatchState, side: Side): string {
  const points = state.currentGame[`${side}Points`];
  const opponent = state.currentGame[`${oppositeSide(side)}Points`];

  if (state.currentGame.isTieBreak) {
    return String(points);
  }

  if (state.config.deuceMode === 'advantage' && points >= 4 && points > opponent) {
    return 'AD';
  }

  return POINT_LABELS[Math.min(points, 3)] ?? '40';
}

export function getCompletedSetCount(state: MatchState, side: Side): number {
  return state.sets.filter((set) => set.status === 'complete' && set.winner === side).length;
}

export function getActiveSet(state: MatchState): MatchSetScore {
  const active = state.sets.find((set) => set.status === 'active');

  if (!active) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'No hay set activo.');
  }

  return active;
}

export function getPointContext(state: MatchState): { side: Side; type: 'set_point' | 'match_point' } | null {
  if (state.status === 'finished' || state.winner) {
    return null;
  }

  for (const side of ['home', 'away'] as const) {
    try {
      const next = addPoint(state, side, `preview-${side}-${state.version}`);
      const beforeSets = getCompletedSetCount(state, side);
      const afterSets = getCompletedSetCount(next, side);

      if (next.winner === side) {
        return { side, type: 'match_point' };
      }

      if (afterSets > beforeSets) {
        return { side, type: 'set_point' };
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function getScoreSnapshot(state: MatchState): ScoreSnapshot {
  return {
    status: state.status,
    sets: cloneSets(state.sets),
    currentGame: { ...state.currentGame },
    winner: state.winner,
  };
}

function mutateWithHistory(
  state: MatchState,
  commandId: string,
  type: MatchHistoryEntry['type'],
  side: Side | null,
  label: string,
  mutate: (draft: MatchState) => void,
): MatchState {
  const before = getScoreSnapshot(state);
  const draft = cloneState(state);

  mutate(draft);

  const after = getScoreSnapshot(draft);
  const now = new Date().toISOString();
  const entry: MatchHistoryEntry = {
    id: `${draft.id}-${draft.version + 1}-${type}`,
    commandId,
    type,
    side,
    label,
    before,
    after,
    createdAt: now,
  };

  return {
    ...draft,
    history: [...draft.history, entry].slice(-80),
    version: draft.version + 1,
    updatedAt: now,
  };
}

function addTieBreakPoint(state: MatchState, side: Side): void {
  const set = getActiveSet(state);
  const nextGame = {
    ...state.currentGame,
    [`${side}Points`]: state.currentGame[`${side}Points`] + 1,
  };

  state.currentGame = nextGame;

  const sidePoints = nextGame[`${side}Points`];
  const opponentPoints = nextGame[`${oppositeSide(side)}Points`];

  if (sidePoints < state.config.tieBreakTarget || sidePoints - opponentPoints < state.config.tieBreakWinBy) {
    return;
  }

  set[`${side}Games`] += 1;
  set.tieBreak = {
    homePoints: nextGame.homePoints,
    awayPoints: nextGame.awayPoints,
    winner: side,
  };
  completeSet(state, set, side);
}

function awardGame(state: MatchState, side: Side): void {
  const set = getActiveSet(state);
  set[`${side}Games`] += 1;

  if (isSetComplete(set, state.config)) {
    completeSet(state, set, side);
    return;
  }

  state.currentGame = createGame(shouldPlayTieBreak(set, state.config));
}

function completeSet(state: MatchState, set: MatchSetScore, winner: Side): void {
  set.status = 'complete';
  set.winner = winner;

  const wonSets = getCompletedSetCount(state, winner);

  if (wonSets >= state.config.setsToWin) {
    state.winner = winner;
    state.status = 'finished';
    state.currentGame = createGame(false);
    return;
  }

  state.sets.push(createActiveSet());
  state.currentGame = createGame(false);
}

function isGameComplete(game: MatchGameScore, config: MatchConfig): boolean {
  const maxPoints = Math.max(game.homePoints, game.awayPoints);
  const diff = Math.abs(game.homePoints - game.awayPoints);

  if (config.deuceMode === 'golden-point') {
    return maxPoints >= 4;
  }

  return maxPoints >= 4 && diff >= 2;
}

function isSetComplete(set: MatchSetScore, config: MatchConfig): boolean {
  const maxGames = Math.max(set.homeGames, set.awayGames);
  const diff = Math.abs(set.homeGames - set.awayGames);

  return maxGames >= config.gamesPerSet && diff >= 2;
}

function shouldPlayTieBreak(set: MatchSetScore, config: MatchConfig): boolean {
  return set.homeGames === config.tieBreakAt && set.awayGames === config.tieBreakAt;
}

function createActiveSet(): MatchSetScore {
  return {
    homeGames: 0,
    awayGames: 0,
    status: 'active',
    winner: null,
    tieBreak: null,
  };
}

function createGame(isTieBreak: boolean): MatchGameScore {
  return {
    homePoints: 0,
    awayPoints: 0,
    isTieBreak,
  };
}

function applySnapshot(state: MatchState, snapshot: ScoreSnapshot): void {
  state.status = snapshot.status;
  state.sets = cloneSets(snapshot.sets);
  state.currentGame = { ...snapshot.currentGame };
  state.winner = snapshot.winner;
}

function cloneState(state: MatchState): MatchState {
  return {
    ...state,
    config: { ...state.config },
    lineups: cloneLineups(state.lineups),
    overlaySettings: { ...normalizeOverlaySettings(state.overlaySettings) },
    cards: cloneMatchCards(state.cards),
    dataScene: cloneDataScene(state.dataScene),
    sets: cloneSets(state.sets),
    currentGame: { ...state.currentGame },
    history: state.history.map((entry) => ({
      ...entry,
      before: cloneSnapshot(entry.before),
      after: cloneSnapshot(entry.after),
    })),
  };
}

function normalizeMatchState(state: MatchState, event: EventDefinition): MatchState {
  return {
    ...state,
    title: state.title || event.title,
    homeTeamId: state.homeTeamId || event.homeTeamId,
    awayTeamId: state.awayTeamId || event.awayTeamId,
    lineups: cloneLineups(state.lineups ?? event.lineups),
    servingSide: state.servingSide === 'away' ? 'away' : event.servingSide,
    courtName: state.courtName || event.courtName,
    config: { ...DEFAULT_MATCH_CONFIG, ...state.config },
    overlaySettings: normalizeOverlaySettings(state.overlaySettings ?? event.overlaySettings),
    cards: normalizeMatchCards(state.cards ?? event.cards),
    dataScene: cloneDataScene(state.dataScene),
    sets: cloneSets(state.sets),
    currentGame: { ...state.currentGame },
    history: state.history.map((entry) => ({
      ...entry,
      before: cloneSnapshot(entry.before),
      after: cloneSnapshot(entry.after),
    })),
  };
}

function applyMetaPatch(state: MatchState, patch: MatchMetaPatch): void {
  if (patch.title !== undefined) {
    state.title = patch.title.trim() || state.title;
  }

  if (patch.homeTeamId !== undefined) {
    state.homeTeamId = patch.homeTeamId;
  }

  if (patch.awayTeamId !== undefined) {
    state.awayTeamId = patch.awayTeamId;
  }

  if (patch.lineups !== undefined) {
    state.lineups = cloneLineups(patch.lineups);
  }

  if (patch.servingSide !== undefined) {
    state.servingSide = patch.servingSide;
  }

  if (patch.courtName !== undefined) {
    state.courtName = patch.courtName.trim();
  }
}

function cloneSnapshot(snapshot: ScoreSnapshot): ScoreSnapshot {
  return {
    status: snapshot.status,
    sets: cloneSets(snapshot.sets),
    currentGame: { ...snapshot.currentGame },
    winner: snapshot.winner,
  };
}

function cloneSets(sets: MatchSetScore[]): MatchSetScore[] {
  return sets.map((set) => ({
    ...set,
    tieBreak: set.tieBreak ? { ...set.tieBreak } : null,
  }));
}

function cloneLineups(lineups: MatchLineups | undefined): MatchLineups {
  const fallback = createEmptyLineups();

  return {
    home: {
      player1: lineups?.home?.player1.trim() ?? fallback.home.player1,
      player2: lineups?.home?.player2.trim() ?? fallback.home.player2,
    },
    away: {
      player1: lineups?.away?.player1.trim() ?? fallback.away.player1,
      player2: lineups?.away?.player2.trim() ?? fallback.away.player2,
    },
  };
}

function normalizeOverlaySettings(settings: Partial<OverlaySettings> | undefined): OverlaySettings {
  return {
    visible: typeof settings?.visible === 'boolean' ? settings.visible : DEFAULT_OVERLAY_SETTINGS.visible,
    size: isOverlaySize(settings?.size) ? settings.size : DEFAULT_OVERLAY_SETTINGS.size,
    position: isOverlayPosition(settings?.position) ? settings.position : DEFAULT_OVERLAY_SETTINGS.position,
    dataScenesAuto:
      typeof settings?.dataScenesAuto === 'boolean'
        ? settings.dataScenesAuto
        : DEFAULT_OVERLAY_SETTINGS.dataScenesAuto,
  };
}

function normalizeMatchCards(cards: Partial<MatchCardsState> | undefined): MatchCardsState {
  const announcement = cloneCardUse(cards?.announcement);

  return {
    home: cloneCardUse(cards?.home),
    away: cloneCardUse(cards?.away),
    announcement: cards?.announcement && announcement
      ? {
          ...announcement,
          id: cards.announcement.id || cards.announcement.usedAt,
        }
      : null,
  };
}

function cloneMatchCards(cards: MatchCardsState | undefined): MatchCardsState {
  return normalizeMatchCards(cards);
}

function cloneCardUse(cardUse: MatchCardUse | null | undefined): MatchCardUse | null {
  if (!cardUse || !isMatchCardId(cardUse.cardId)) {
    return null;
  }

  return {
    side: cardUse.side === 'away' ? 'away' : 'home',
    teamId: cardUse.teamId,
    cardId: cardUse.cardId,
    cardName: cardUse.cardName,
    usedAt: cardUse.usedAt,
  };
}

function cloneDataScene(scene: OverlayDataSceneState | null | undefined): OverlayDataSceneState | null {
  if (!scene || !isOverlayDataSceneKind(scene.kind)) {
    return null;
  }

  return {
    id: scene.id,
    kind: scene.kind,
    target: normalizeDataSceneTarget(scene.target),
    triggeredAt: scene.triggeredAt,
  };
}

function normalizeDataSceneTarget(target: unknown): OverlayDataSceneTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return { type: 'league' };
  }

  const record = target as Record<string, unknown>;

  if (record.type === 'side') {
    return { type: 'side', side: record.side === 'away' ? 'away' : 'home' };
  }

  if (record.type === 'team' && typeof record.teamId === 'string' && record.teamId.trim()) {
    return { type: 'team', teamId: record.teamId.trim() };
  }

  return { type: 'league' };
}

function isOverlaySize(value: unknown): value is OverlaySettings['size'] {
  return value === 'compact' || value === 'standard' || value === 'large';
}

function isOverlayPosition(value: unknown): value is OverlaySettings['position'] {
  return value === 'top-left' || value === 'center' || value === 'bottom-center';
}

function isMatchCardId(value: unknown): value is MatchCardId {
  return MATCH_CARD_IDS.includes(value as MatchCardId);
}

function isOverlayDataSceneKind(value: unknown): value is OverlayDataSceneKind {
  return OVERLAY_DATA_SCENE_KINDS.includes(value as OverlayDataSceneKind);
}

function oppositeSide(side: Side): Side {
  return side === 'home' ? 'away' : 'home';
}

function sideLabel(side: Side): string {
  return side === 'home' ? 'local' : 'visitante';
}

function dataSceneLabel(kind: OverlayDataSceneKind): string {
  return {
    standings: 'Clasificacion OBS',
    'player-ranking': 'Ranking jugadores OBS',
    'team-roster': 'Plantilla OBS',
    calendar: 'Calendario OBS',
    'upcoming-matches': 'Proximos partidos OBS',
    'latest-results': 'Ultimos resultados OBS',
  }[kind];
}

function validateMatchShape(state: MatchState): void {
  if (!state.sets.length) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'El marcador necesita al menos un set.');
  }

  const activeSets = state.sets.filter((set) => set.status === 'active').length;

  if (state.status !== 'finished' && activeSets !== 1) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'El partido debe tener un set activo.');
  }

  if (state.currentGame.homePoints < 0 || state.currentGame.awayPoints < 0) {
    throw new ScoreEngineError('VALIDATION_ERROR', 'Los puntos no pueden ser negativos.');
  }
}
