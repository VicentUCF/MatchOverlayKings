import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLeagueSnapshot,
  clearLeagueDataCache,
  fetchLeagueSnapshot,
  normalizeTeamName,
} from './league-data.js';
import type { Team } from '@kpl/shared';

const localTeams: Team[] = [
  {
    id: 'kings-of-favar',
    name: 'Kings of Favar',
    shortName: 'Kings',
    logoUrl: '/logos/kings.png',
    primaryColor: '#D1007A',
    secondaryColor: '#0F1115',
  },
  {
    id: 'red-lions',
    name: 'Red Lions',
    shortName: 'Red Lions',
    logoUrl: '/logos/red-lions.png',
    primaryColor: '#E21A23',
    secondaryColor: '#14151A',
  },
];

afterEach(() => {
  clearLeagueDataCache();
  vi.restoreAllMocks();
});

describe('league data connector', () => {
  it('normalizes team names across local slugs and API names', () => {
    expect(normalizeTeamName('Kings Of Favar')).toBe(normalizeTeamName('Kings of Favar'));
    expect(normalizeTeamName('Red Lions')).toBe('redlions');
  });

  it('builds standings, player ranking, and Red Lions fallback', () => {
    const snapshot = buildLeagueSnapshot({
      teams: [
        { id: 'api-kings', name: 'Kings Of Favar', logo: 'https://placeholder.com/logos/team1.png', primaryColor: '#000000' },
        { id: 'api-magic', name: 'Magic City', logo: 'https://placeholder.com/logos/team2.png', primaryColor: '#000000' },
      ],
      players: [
        {
          id: 'player-1',
          firstName: 'Ada',
          lastName: 'Padel',
          preferredPosition: 'left',
          profileImage: 'https://cdn.example.com/ada.png',
          teamId: 'api-kings',
          isPresident: false,
        },
        {
          id: 'player-2',
          firstName: 'Berta',
          lastName: 'Drive',
          preferredPosition: 'right',
          teamId: 'api-magic',
          isPresident: false,
        },
      ],
      matchdays: [{ id: 'day-1', name: 'Jornada 1', scheduledAt: '2026-05-03T15:00:00.000Z', status: 'finished' }],
      matches: [
        {
          id: 'match-1',
          matchdayId: 'day-1',
          localTeamId: 'api-kings',
          awayTeamId: 'api-magic',
          localTeamScorePoints: 3,
          awayTeamScorePoints: 2,
          scheduledAt: '2026-05-03T15:00:00.000Z',
          status: 'finished',
        },
      ],
      lineups: [],
      lineupPairs: [],
      pairMatches: [],
      playerScores: [
        { playerId: 'player-2', totalPoints: 7, wonPairMatches: 3, wonSets: 4, wonGames: 21 },
        { playerId: 'player-1', totalPoints: 9, wonPairMatches: 2, wonSets: 4, wonGames: 20 },
      ],
    }, localTeams);

    expect(snapshot.standings[0]).toMatchObject({
      localTeamId: 'kings-of-favar',
      points: 3,
      logoUrl: '/logos/kings.png',
      primaryColor: '#D1007A',
    });
    expect(snapshot.playerRanking.map((player) => player.displayName)).toEqual(['Ada Padel', 'Berta Drive']);
    expect(snapshot.teams.find((team) => team.localTeamId === 'red-lions')).toMatchObject({
      name: 'Red Lions',
      dataStatus: 'pending',
      players: [],
    });
  });

  it('fetches all pages and reuses cache within the TTL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = url.searchParams.get('page') ?? '1';
      const path = url.pathname;

      if (path === '/v1/teams') {
        return jsonResponse({
          items: page === '1'
            ? [{ id: 'api-kings', name: 'Kings Of Favar' }]
            : [{ id: 'api-magic', name: 'Magic City' }],
          meta: { currentPage: Number(page), totalPages: 2 },
        });
      }

      return jsonResponse({ items: [], meta: { currentPage: 1, totalPages: 1 } });
    });

    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchLeagueSnapshot(localTeams);
    const second = await fetchLeagueSnapshot(localTeams);

    expect(first.teams.some((team) => team.name === 'Kings of Favar')).toBe(true);
    expect(second.teams).toHaveLength(first.teams.length);
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/v1/teams')).toHaveLength(2);
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
