export type TeamId = string;
export type EventId = string;
export type Side = 'home' | 'away';
export type MatchStatus = 'pre_match' | 'live' | 'finished';
export type DeuceMode = 'golden-point' | 'advantage';
export type ClientRole = 'control' | 'overlay' | 'viewer';
export type OverlaySize = 'compact' | 'standard' | 'large';
export type OverlayPosition = 'top-left' | 'center' | 'bottom-center';
export type MatchCardId =
  | '2vs1'
  | 'restas-tu'
  | 'cambiate'
  | 'robo-saque'
  | 'solo-un-saque'
  | 'comodin'
  | 'robo-carta';

export interface Team {
  id: TeamId;
  name: string;
  shortName: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
}

export interface MatchConfig {
  setsToWin: number;
  gamesPerSet: number;
  tieBreakAt: number;
  tieBreakTarget: number;
  tieBreakWinBy: number;
  deuceMode: DeuceMode;
}

export interface TeamLineup {
  player1: string;
  player2: string;
}

export interface MatchLineups {
  home: TeamLineup;
  away: TeamLineup;
}

export interface MatchSetScore {
  homeGames: number;
  awayGames: number;
  status: 'active' | 'complete';
  winner: Side | null;
  tieBreak: TieBreakScore | null;
}

export interface TieBreakScore {
  homePoints: number;
  awayPoints: number;
  winner: Side | null;
}

export interface MatchGameScore {
  homePoints: number;
  awayPoints: number;
  isTieBreak: boolean;
}

export interface OverlaySettings {
  visible: boolean;
  size: OverlaySize;
  position: OverlayPosition;
}

export type OverlaySettingsPatch = Partial<OverlaySettings>;

export interface MatchCardUse {
  side: Side;
  teamId: TeamId;
  cardId: MatchCardId;
  cardName: string;
  usedAt: string;
}

export interface MatchCardAnnouncement extends MatchCardUse {
  id: string;
}

export interface MatchCardsState {
  home: MatchCardUse | null;
  away: MatchCardUse | null;
  announcement: MatchCardAnnouncement | null;
}

export interface ScoreSnapshot {
  status: MatchStatus;
  sets: MatchSetScore[];
  currentGame: MatchGameScore;
  winner: Side | null;
}

export interface MatchHistoryEntry {
  id: string;
  commandId: string;
  type:
    | 'add_point'
    | 'undo'
    | 'reset'
    | 'manual_patch'
    | 'update_meta'
    | 'set_status'
    | 'new_match'
    | 'update_overlay'
    | 'use_card';
  side: Side | null;
  label: string;
  before: ScoreSnapshot;
  after: ScoreSnapshot;
  createdAt: string;
}

export interface MatchState {
  id: EventId;
  title: string;
  homeTeamId: TeamId;
  awayTeamId: TeamId;
  lineups: MatchLineups;
  servingSide: Side;
  courtName: string;
  status: MatchStatus;
  config: MatchConfig;
  sets: MatchSetScore[];
  currentGame: MatchGameScore;
  winner: Side | null;
  overlaySettings: OverlaySettings;
  cards: MatchCardsState;
  history: MatchHistoryEntry[];
  version: number;
  updatedAt: string;
}

export interface EventDefinition {
  id: EventId;
  title: string;
  homeTeamId: TeamId;
  awayTeamId: TeamId;
  lineups: MatchLineups;
  servingSide: Side;
  courtName: string;
  status: MatchStatus;
  config: MatchConfig;
  overlaySettings?: OverlaySettings;
  cards?: MatchCardsState;
  state: MatchState | null;
}

export interface MatchMetaPatch {
  title?: string;
  homeTeamId?: TeamId;
  awayTeamId?: TeamId;
  lineups?: MatchLineups;
  servingSide?: Side;
  courtName?: string;
}

export interface NewMatchSetup extends MatchMetaPatch {
  homeTeamId: TeamId;
  awayTeamId: TeamId;
  lineups: MatchLineups;
  servingSide: Side;
}

export interface ManualScorePatch {
  status?: MatchStatus;
  sets?: MatchSetScore[];
  currentGame?: MatchGameScore;
  winner?: Side | null;
}

export interface JoinEventPayload {
  eventId: EventId;
  role: ClientRole;
  pin?: string;
}

export interface VersionedCommandPayload {
  eventId: EventId;
  expectedVersion: number;
  commandId: string;
}

export interface AddPointPayload extends VersionedCommandPayload {
  side: Side;
}

export interface ManualPatchPayload extends VersionedCommandPayload {
  patch: ManualScorePatch;
}

export interface UpdateMetaPayload extends VersionedCommandPayload {
  patch: MatchMetaPatch;
}

export interface SetStatusPayload extends VersionedCommandPayload {
  status: MatchStatus;
}

export interface NewMatchPayload extends VersionedCommandPayload {
  setup: NewMatchSetup;
}

export interface UpdateOverlaySettingsPayload extends VersionedCommandPayload {
  patch: OverlaySettingsPatch;
}

export interface UseMatchCardPayload extends VersionedCommandPayload {
  side: Side;
  cardId: MatchCardId;
  cardName: string;
}

export type CommandErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'MATCH_FINISHED'
  | 'VALIDATION_ERROR'
  | 'SERVER_ERROR';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  currentVersion?: number;
}

export type Ack<T> = { ok: true; data: T } | { ok: false; error: CommandError };

export interface StateUpdatedPayload {
  eventId: EventId;
  state: MatchState;
}

export interface ServerToClientEvents {
  'state:updated': (payload: StateUpdatedPayload) => void;
}

export interface ClientToServerEvents {
  'join:event': (payload: JoinEventPayload, ack: (response: Ack<MatchState>) => void) => void;
  'score:addPoint': (payload: AddPointPayload, ack: (response: Ack<MatchState>) => void) => void;
  'score:undo': (payload: VersionedCommandPayload, ack: (response: Ack<MatchState>) => void) => void;
  'score:resetMatch': (
    payload: VersionedCommandPayload,
    ack: (response: Ack<MatchState>) => void,
  ) => void;
  'score:manualPatch': (
    payload: ManualPatchPayload,
    ack: (response: Ack<MatchState>) => void,
  ) => void;
  'match:updateMeta': (
    payload: UpdateMetaPayload,
    ack: (response: Ack<MatchState>) => void,
  ) => void;
  'match:setStatus': (payload: SetStatusPayload, ack: (response: Ack<MatchState>) => void) => void;
  'match:newMatch': (payload: NewMatchPayload, ack: (response: Ack<MatchState>) => void) => void;
  'overlay:updateSettings': (
    payload: UpdateOverlaySettingsPayload,
    ack: (response: Ack<MatchState>) => void,
  ) => void;
  'match:useCard': (
    payload: UseMatchCardPayload,
    ack: (response: Ack<MatchState>) => void,
  ) => void;
}
