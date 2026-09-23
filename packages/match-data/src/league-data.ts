import type { Team } from '@kpl/shared';

const API_BASE_URL = 'https://kings-league-api.esteveep.dev';
const CACHE_TTL_MS = 60_000;
const PAGE_SIZE = 200;

export interface LeagueSnapshot {
  loadedAt: string;
  teams: LeagueTeam[];
  standings: LeagueStanding[];
  playerRanking: LeaguePlayerRanking[];
  matchdays: LeagueMatchday[];
  calendarMatches: LeagueMatch[];
  upcomingMatches: LeagueMatch[];
  latestResults: LeagueMatch[];
}

export interface LeagueTeam {
  externalId: string | null;
  localTeamId: string | null;
  name: string;
  shortName: string;
  logoUrl: string;
  primaryColor: string;
  players: LeaguePlayer[];
  presidentName: string | null;
  standing: LeagueStanding | null;
  dataStatus: 'ready' | 'pending';
}

export interface LeaguePlayer {
  id: string;
  displayName: string;
  alias: string | null;
  roleLabel: string;
  photoUrl: string | null;
  teamName: string;
  teamId: string | null;
  isPresident: boolean;
}

export interface LeagueStanding {
  rank: number;
  externalTeamId: string | null;
  localTeamId: string | null;
  teamName: string;
  shortName: string;
  logoUrl: string;
  primaryColor: string;
  playedMatches: number;
  wonMatches: number;
  lostMatches: number;
  points: number;
  gameDifference: number;
}

export interface LeaguePlayerRanking extends LeaguePlayer {
  rank: number;
  totalPoints: number;
  wonPairMatches: number;
  lostPairMatches: number;
  wonSets: number;
  lostSets: number;
  wonGames: number;
  lostGames: number;
}

export interface LeagueMatchday {
  id: string;
  name: string;
  status: 'scheduled' | 'in_progress' | 'finished';
  scheduledAtIso: string;
  dateLabel: string;
  matches: LeagueMatch[];
}

export interface LeagueMatch {
  id: string;
  matchdayId: string;
  matchdayName: string;
  status: 'scheduled' | 'in_progress' | 'finished';
  scheduledAtIso: string;
  scheduledAtLabel: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  pairResults: LeaguePairResult[];
}

export interface LeaguePairResult {
  label: string;
  homePlayers: string[];
  awayPlayers: string[];
  homeScoreLabel: string;
  awayScoreLabel: string;
  winnerTeamName: string | null;
}

interface ApiCollection<TItem> {
  items: TItem[];
  meta?: {
    currentPage?: number;
    totalPages?: number;
  };
}

interface ApiTeam {
  id: string;
  name: string;
  logo?: string;
  primaryColor?: string;
}

interface ApiPlayer {
  id: string;
  alias?: string;
  firstName?: string;
  lastName?: string;
  preferredPosition?: 'left' | 'right' | 'both';
  profileImage?: string;
  teamId?: string;
  isPresident?: boolean;
}

interface ApiMatchday {
  id: string;
  name: string;
  scheduledAt: string;
  status: 'scheduled' | 'in_progress' | 'finished';
}

interface ApiMatch {
  id: string;
  matchdayId: string;
  localTeamId: string;
  awayTeamId: string;
  localTeamScorePoints?: number;
  awayTeamScorePoints?: number;
  scheduledAt: string;
  status: 'scheduled' | 'in_progress' | 'finished';
}

interface ApiLineup {
  id: string;
  matchId: string;
  teamId: string;
}

interface ApiLineupPair {
  id: string;
  matchTeamLineUpId: string;
  player1Id: string;
  player2Id: string;
}

interface ApiPairMatch {
  id: string;
  localLineUpPairId: string;
  awayLineUpPairId: string;
  order?: number;
  setsResult?: Array<{ local?: number; away?: number }>;
}

interface ApiSeasonPlayerScore {
  playerId: string;
  totalPoints?: number;
  wonPairMatches?: number;
  lostPairMatches?: number;
  wonSets?: number;
  lostSets?: number;
  wonGames?: number;
  lostGames?: number;
}

interface LeagueDataset {
  teams: ApiTeam[];
  players: ApiPlayer[];
  matchdays: ApiMatchday[];
  matches: ApiMatch[];
  lineups: ApiLineup[];
  lineupPairs: ApiLineupPair[];
  pairMatches: ApiPairMatch[];
  playerScores: ApiSeasonPlayerScore[];
}

const collectionCache = new Map<string, { expiresAt: number; promise: Promise<unknown[]> }>();

export async function fetchLeagueSnapshot(localTeams: Team[] = [], force = false): Promise<LeagueSnapshot> {
  const dataset = await fetchLeagueDataset(force);
  return buildLeagueSnapshot(dataset, localTeams);
}

export function clearLeagueDataCache(): void {
  collectionCache.clear();
}

export function buildLeagueSnapshot(dataset: LeagueDataset, localTeams: Team[] = []): LeagueSnapshot {
  const externalTeamById = new Map(dataset.teams.map((team) => [team.id, team]));
  const localTeamByName = new Map(localTeams.map((team) => [normalizeTeamName(team.name), team]));
  const localTeamById = new Map(localTeams.map((team) => [team.id, team]));
  const playerById = new Map(dataset.players.map((player) => [player.id, player]));
  const lineupByMatchId = groupBy(dataset.lineups, (lineup) => lineup.matchId);
  const lineupPairsByLineupId = groupBy(dataset.lineupPairs, (pair) => pair.matchTeamLineUpId);
  const pairMatchByLocalPairId = new Map(dataset.pairMatches.map((pairMatch) => [pairMatch.localLineUpPairId, pairMatch]));
  const matchdayById = new Map(dataset.matchdays.map((matchday) => [matchday.id, matchday]));
  const apiPlayersByTeamId = groupBy(dataset.players, (player) => player.teamId ?? '');
  const localMatchByExternalId = new Map<string, Team>();

  for (const externalTeam of dataset.teams) {
    const localTeam = localTeamByName.get(normalizeTeamName(externalTeam.name));

    if (localTeam) {
      localMatchByExternalId.set(externalTeam.id, localTeam);
    }
  }

  const matches = dataset.matches
    .map((match) => mapMatch(match, {
      externalTeamById,
      matchdayById,
      lineupByMatchId,
      lineupPairsByLineupId,
      pairMatchByLocalPairId,
      playerById,
    }))
    .sort((left, right) => Date.parse(left.scheduledAtIso) - Date.parse(right.scheduledAtIso));

  const matchdays = dataset.matchdays
    .slice()
    .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))
    .map((matchday) => ({
      id: matchday.id,
      name: matchday.name,
      status: normalizeStatus(matchday.status),
      scheduledAtIso: matchday.scheduledAt,
      dateLabel: formatLongDate(matchday.scheduledAt),
      matches: matches.filter((match) => match.matchdayId === matchday.id),
    }));

  const standings = buildStandings(dataset.teams, dataset.matches, localMatchByExternalId, localTeamById);
  const standingByExternalId = new Map(standings.map((standing) => [standing.externalTeamId, standing]));
  const teams = buildTeams({
    externalTeams: dataset.teams,
    localTeams,
    apiPlayersByTeamId,
    localMatchByExternalId,
    standingByExternalId,
  });
  const playerByApiId = new Map(teams.flatMap((team) => team.players.map((player) => [player.id, player] as const)));
  const playerRanking = dataset.playerScores
    .map((score) => {
      const player = playerByApiId.get(score.playerId);

      if (!player) {
        return null;
      }

      return {
        ...player,
        rank: 0,
        totalPoints: safeNumber(score.totalPoints),
        wonPairMatches: safeNumber(score.wonPairMatches),
        lostPairMatches: safeNumber(score.lostPairMatches),
        wonSets: safeNumber(score.wonSets),
        lostSets: safeNumber(score.lostSets),
        wonGames: safeNumber(score.wonGames),
        lostGames: safeNumber(score.lostGames),
      };
    })
    .filter((player): player is Omit<LeaguePlayerRanking, 'rank'> & { rank: number } => Boolean(player))
    .sort(comparePlayerRanking)
    .map((player, index) => ({ ...player, rank: index + 1 }));
  const latestResults = matches
    .filter((match) => match.status === 'finished')
    .sort((left, right) => Date.parse(right.scheduledAtIso) - Date.parse(left.scheduledAtIso))
    .slice(0, 8);
  const upcomingMatches = matches
    .filter((match) => match.status !== 'finished')
    .sort((left, right) => Date.parse(left.scheduledAtIso) - Date.parse(right.scheduledAtIso))
    .slice(0, 8);

  return {
    loadedAt: new Date().toISOString(),
    teams,
    standings,
    playerRanking,
    matchdays,
    calendarMatches: matches,
    upcomingMatches,
    latestResults,
  };
}

export function normalizeTeamName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\bof\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function fetchLeagueDataset(force: boolean): Promise<LeagueDataset> {
  const [teams, players, matchdays, matches, lineups, lineupPairs, pairMatches, playerScores] = await Promise.all([
    fetchCollection<ApiTeam>('teams', '/v1/teams', force),
    fetchCollection<ApiPlayer>('players', '/v1/players', force),
    fetchCollection<ApiMatchday>('matchdays', '/v1/matchdays', force),
    fetchCollection<ApiMatch>('matches', '/v1/matches', force),
    fetchCollection<ApiLineup>('lineups', '/v1/match-team-line-ups', force),
    fetchCollection<ApiLineupPair>('lineup-pairs', '/v1/match-team-line-up-pairs', force),
    fetchCollection<ApiPairMatch>('pair-matches', '/v1/pair-matches', force),
    fetchCollection<ApiSeasonPlayerScore>('season-player-scores', '/v1/season-player-scores', force),
  ]);

  return { teams, players, matchdays, matches, lineups, lineupPairs, pairMatches, playerScores };
}

async function fetchCollection<TItem>(cacheKey: string, path: string, force: boolean): Promise<TItem[]> {
  const now = Date.now();
  const cached = collectionCache.get(cacheKey);

  if (!force && cached && cached.expiresAt > now) {
    return cached.promise as Promise<TItem[]>;
  }

  const promise = fetchAllPages<TItem>(path);
  collectionCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, promise });

  try {
    return await promise;
  } catch (error) {
    if (collectionCache.get(cacheKey)?.promise === promise) {
      collectionCache.delete(cacheKey);
    }

    throw error;
  }
}

async function fetchAllPages<TItem>(path: string): Promise<TItem[]> {
  const first = await fetchPage<TItem>(path, 1);
  const totalPages = Math.max(1, first.meta?.totalPages ?? 1);

  if (totalPages === 1) {
    return first.items;
  }

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_item, index) => fetchPage<TItem>(path, index + 2)),
  );

  return [first, ...rest].flatMap((page) => page.items);
}

async function fetchPage<TItem>(path: string, page: number): Promise<ApiCollection<TItem>> {
  const url = new URL(path, API_BASE_URL);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`No se pudo cargar ${path}: ${response.status}`);
  }

  const payload = await response.json() as ApiCollection<TItem>;

  if (!Array.isArray(payload.items)) {
    throw new Error(`Respuesta invalida de ${path}.`);
  }

  return payload;
}

function buildTeams({
  externalTeams,
  localTeams,
  apiPlayersByTeamId,
  localMatchByExternalId,
  standingByExternalId,
}: {
  externalTeams: ApiTeam[];
  localTeams: Team[];
  apiPlayersByTeamId: Map<string, ApiPlayer[]>;
  localMatchByExternalId: Map<string, Team>;
  standingByExternalId: Map<string | null, LeagueStanding>;
}): LeagueTeam[] {
  const usedLocalIds = new Set<string>();
  const teams: LeagueTeam[] = externalTeams.map((externalTeam) => {
    const localTeam = localMatchByExternalId.get(externalTeam.id) ?? null;

    if (localTeam) {
      usedLocalIds.add(localTeam.id);
    }

    const players = (apiPlayersByTeamId.get(externalTeam.id) ?? []).map((player) =>
      mapPlayer(player, externalTeam.name, localTeam?.id ?? null),
    );

    return {
      externalId: externalTeam.id,
      localTeamId: localTeam?.id ?? null,
      name: localTeam?.name ?? externalTeam.name,
      shortName: localTeam?.shortName ?? externalTeam.name,
      logoUrl: localTeam?.logoUrl ?? nonPlaceholderUrl(externalTeam.logo) ?? '',
      primaryColor: localTeam?.primaryColor ?? validColor(externalTeam.primaryColor) ?? '#c9a227',
      players,
      presidentName: players.find((player) => player.isPresident)?.displayName ?? null,
      standing: standingByExternalId.get(externalTeam.id) ?? null,
      dataStatus: 'ready' as const,
    };
  });

  for (const localTeam of localTeams) {
    if (usedLocalIds.has(localTeam.id)) {
      continue;
    }

    teams.push({
      externalId: null,
      localTeamId: localTeam.id,
      name: localTeam.name,
      shortName: localTeam.shortName,
      logoUrl: localTeam.logoUrl,
      primaryColor: localTeam.primaryColor,
      players: [],
      presidentName: null,
      standing: null,
      dataStatus: 'pending',
    });
  }

  return teams.sort((left, right) => left.name.localeCompare(right.name, 'es'));
}

function buildStandings(
  teams: ApiTeam[],
  matches: ApiMatch[],
  localMatchByExternalId: Map<string, Team>,
  localTeamById: Map<string, Team>,
): LeagueStanding[] {
  const stats = new Map(teams.map((team) => [team.id, { points: 0, played: 0, won: 0, lost: 0, gameDifference: 0 }]));

  for (const match of matches) {
    if (normalizeStatus(match.status) !== 'finished') {
      continue;
    }

    const home = stats.get(match.localTeamId);
    const away = stats.get(match.awayTeamId);

    if (!home || !away) {
      continue;
    }

    const homeScore = safeNumber(match.localTeamScorePoints);
    const awayScore = safeNumber(match.awayTeamScorePoints);
    const difference = homeScore - awayScore;
    home.points += homeScore;
    away.points += awayScore;
    home.played += 1;
    away.played += 1;
    home.gameDifference += difference;
    away.gameDifference -= difference;

    if (homeScore > awayScore) {
      home.won += 1;
      away.lost += 1;
    } else if (awayScore > homeScore) {
      away.won += 1;
      home.lost += 1;
    }
  }

  return teams
    .map((team) => {
      const localTeam = localMatchByExternalId.get(team.id);
      const mergedTeam = localTeam ? localTeamById.get(localTeam.id) : null;
      const teamStats = stats.get(team.id);

      return {
        rank: 0,
        externalTeamId: team.id,
        localTeamId: mergedTeam?.id ?? null,
        teamName: mergedTeam?.name ?? team.name,
        shortName: mergedTeam?.shortName ?? team.name,
        logoUrl: mergedTeam?.logoUrl ?? nonPlaceholderUrl(team.logo) ?? '',
        primaryColor: mergedTeam?.primaryColor ?? validColor(team.primaryColor) ?? '#c9a227',
        playedMatches: teamStats?.played ?? 0,
        wonMatches: teamStats?.won ?? 0,
        lostMatches: teamStats?.lost ?? 0,
        points: teamStats?.points ?? 0,
        gameDifference: teamStats?.gameDifference ?? 0,
      };
    })
    .sort((left, right) =>
      right.points - left.points
      || right.gameDifference - left.gameDifference
      || left.teamName.localeCompare(right.teamName, 'es'),
    )
    .map((standing, index) => ({ ...standing, rank: index + 1 }));
}

function mapMatch(
  match: ApiMatch,
  lookup: {
    externalTeamById: Map<string, ApiTeam>;
    matchdayById: Map<string, ApiMatchday>;
    lineupByMatchId: Map<string, ApiLineup[]>;
    lineupPairsByLineupId: Map<string, ApiLineupPair[]>;
    pairMatchByLocalPairId: Map<string, ApiPairMatch>;
    playerById: Map<string, ApiPlayer>;
  },
): LeagueMatch {
  const matchday = lookup.matchdayById.get(match.matchdayId);
  const lineups = lookup.lineupByMatchId.get(match.id) ?? [];
  const homeLineup = lineups.find((lineup) => lineup.teamId === match.localTeamId);
  const awayLineup = lineups.find((lineup) => lineup.teamId === match.awayTeamId);
  const homePairs = homeLineup ? lookup.lineupPairsByLineupId.get(homeLineup.id) ?? [] : [];
  const awayPairs = awayLineup ? lookup.lineupPairsByLineupId.get(awayLineup.id) ?? [] : [];
  const awayPairById = new Map(awayPairs.map((pair) => [pair.id, pair]));
  const pairResults = homePairs
    .map((homePair, index) => {
      const pairMatch = lookup.pairMatchByLocalPairId.get(homePair.id);
      const awayPair = pairMatch ? awayPairById.get(pairMatch.awayLineUpPairId) : awayPairs[index];

      if (!awayPair) {
        return null;
      }

      const score = formatPairScore(pairMatch?.setsResult);

      return {
        label: `Pareja ${safeNumber(pairMatch?.order) || index + 1}`,
        homePlayers: playerNames(homePair, lookup.playerById),
        awayPlayers: playerNames(awayPair, lookup.playerById),
        homeScoreLabel: score.home,
        awayScoreLabel: score.away,
        winnerTeamName: pairWinner(score, lookup.externalTeamById.get(match.localTeamId)?.name, lookup.externalTeamById.get(match.awayTeamId)?.name),
      };
    })
    .filter((pair): pair is LeaguePairResult => Boolean(pair));

  return {
    id: match.id,
    matchdayId: match.matchdayId,
    matchdayName: matchday?.name ?? 'Jornada',
    status: normalizeStatus(match.status),
    scheduledAtIso: match.scheduledAt,
    scheduledAtLabel: formatShortDate(match.scheduledAt),
    homeTeamName: lookup.externalTeamById.get(match.localTeamId)?.name ?? match.localTeamId,
    awayTeamName: lookup.externalTeamById.get(match.awayTeamId)?.name ?? match.awayTeamId,
    homeScore: safeNumber(match.localTeamScorePoints),
    awayScore: safeNumber(match.awayTeamScorePoints),
    pairResults,
  };
}

function mapPlayer(player: ApiPlayer, teamName: string, teamId: string | null): LeaguePlayer {
  return {
    id: player.id,
    displayName: displayName(player),
    alias: textOrNull(player.alias),
    roleLabel: positionLabel(player.preferredPosition),
    photoUrl: nonPlaceholderUrl(player.profileImage),
    teamName,
    teamId,
    isPresident: player.isPresident === true,
  };
}

function comparePlayerRanking(left: Omit<LeaguePlayerRanking, 'rank'>, right: Omit<LeaguePlayerRanking, 'rank'>): number {
  return right.totalPoints - left.totalPoints
    || right.wonPairMatches - left.wonPairMatches
    || right.wonSets - left.wonSets
    || right.wonGames - left.wonGames
    || left.displayName.localeCompare(right.displayName, 'es');
}

function groupBy<TItem>(items: TItem[], key: (item: TItem) => string): Map<string, TItem[]> {
  const grouped = new Map<string, TItem[]>();

  for (const item of items) {
    const groupKey = key(item);
    const group = grouped.get(groupKey) ?? [];
    group.push(item);
    grouped.set(groupKey, group);
  }

  return grouped;
}

function displayName(player: Pick<ApiPlayer, 'firstName' | 'lastName' | 'alias'>): string {
  const fullName = [player.firstName, player.lastName].map((part) => part?.trim()).filter(Boolean).join(' ');
  return fullName || player.alias?.trim() || 'Jugador';
}

function positionLabel(position: ApiPlayer['preferredPosition']): string {
  return {
    left: 'Reves',
    right: 'Derecha',
    both: 'Ambas',
  }[position ?? 'both'];
}

function normalizeStatus(status: ApiMatch['status']): LeagueMatch['status'] {
  return status === 'finished' || status === 'in_progress' ? status : 'scheduled';
}

function formatPairScore(sets: ApiPairMatch['setsResult']): { home: string; away: string } {
  if (!Array.isArray(sets) || sets.length === 0) {
    return { home: 'Pendiente', away: 'Pendiente' };
  }

  const validSets = sets
    .map((set) => ({ home: safeNumber(set.local), away: safeNumber(set.away) }))
    .filter((set) => Number.isFinite(set.home) && Number.isFinite(set.away));

  if (validSets.length === 0) {
    return { home: 'Pendiente', away: 'Pendiente' };
  }

  return {
    home: validSets.map((set) => set.home).join(' / '),
    away: validSets.map((set) => set.away).join(' / '),
  };
}

function pairWinner(score: { home: string; away: string }, homeTeamName: string | undefined, awayTeamName: string | undefined): string | null {
  const homeSets = score.home.split('/').map((item) => Number(item.trim()));
  const awaySets = score.away.split('/').map((item) => Number(item.trim()));

  if (homeSets.some(Number.isNaN) || awaySets.some(Number.isNaN)) {
    return null;
  }

  const homeWon = homeSets.filter((value, index) => value > (awaySets[index] ?? 0)).length;
  const awayWon = awaySets.filter((value, index) => value > (homeSets[index] ?? 0)).length;

  if (homeWon > awayWon) {
    return homeTeamName ?? null;
  }

  if (awayWon > homeWon) {
    return awayTeamName ?? null;
  }

  return null;
}

function playerNames(pair: ApiLineupPair, playerById: Map<string, ApiPlayer>): string[] {
  return [pair.player1Id, pair.player2Id]
    .map((id) => playerById.get(id))
    .filter((player): player is ApiPlayer => Boolean(player))
    .map(displayName);
}

function textOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nonPlaceholderUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed || trimmed.includes('placeholder.com')) {
    return null;
  }

  return trimmed;
}

function validColor(value: string | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === '#000000') {
    return null;
  }

  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : null;
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(value));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value)).replace(/\./g, '');
}
