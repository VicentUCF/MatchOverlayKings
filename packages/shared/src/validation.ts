import type { EventDefinition, MatchConfig, MatchLineups, MatchState, Side, Team } from './types.js';

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

function readStatus(value: unknown): EventDefinition['status'] {
  if (value === 'pre_match' || value === 'live' || value === 'finished') {
    return value;
  }

  throw new Error('status invalido.');
}
