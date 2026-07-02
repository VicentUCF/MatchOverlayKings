import type { MatchState, Team } from '@kpl/shared';
import { assertSupabaseConfig, supabase } from './supabase.js';

export interface EventSummary {
  id: string;
  title: string;
  courtName: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchState['status'];
  version: number;
  updatedAt: string;
}

interface TeamRow {
  id: string;
  name: string;
  short_name: string;
  logo_url: string;
  primary_color: string;
  secondary_color: string;
}

interface ScoreStateRow {
  court_slug: string;
  title: string;
  court_name: string;
  home_team_id: string;
  away_team_id: string;
  status: MatchState['status'];
  version: number;
  updated_at: string;
  state: MatchState;
}

const SCORE_STATE_COLUMNS = 'court_slug,title,court_name,home_team_id,away_team_id,status,version,updated_at,state';

export async function fetchTeams(): Promise<Team[]> {
  assertSupabaseConfig();

  const { data, error } = await supabase
    .from('teams')
    .select('id,name,short_name,logo_url,primary_color,secondary_color')
    .order('name');

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as TeamRow[]).map((team) => ({
    id: team.id,
    name: team.name,
    shortName: team.short_name,
    logoUrl: team.logo_url,
    primaryColor: team.primary_color,
    secondaryColor: team.secondary_color,
  }));
}

export async function fetchEventSummaries(options: { liveOnly: boolean }): Promise<EventSummary[]> {
  assertSupabaseConfig();

  let query = supabase
    .from('score_states')
    .select(SCORE_STATE_COLUMNS)
    .order('court_slug');

  if (options.liveOnly) {
    query = query.eq('status', 'live');
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as ScoreStateRow[]).map(scoreStateRowToEventSummary);
}

export async function fetchMatchState(courtSlug: string): Promise<MatchState | null> {
  assertSupabaseConfig();

  const { data, error } = await supabase
    .from('score_states')
    .select(SCORE_STATE_COLUMNS)
    .eq('court_slug', courtSlug)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? ((data as ScoreStateRow).state as MatchState) : null;
}

export function subscribeToMatchState(courtSlug: string, onState: (state: MatchState) => void): () => void {
  assertSupabaseConfig();

  const channel = supabase
    .channel(`score-state:${courtSlug}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'score_states',
        filter: `court_slug=eq.${courtSlug}`,
      },
      (payload) => {
        const next = payload.new as ScoreStateRow | undefined;

        if (next?.state) {
          onState(next.state as MatchState);
        }
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export function subscribeToScoreStates(onChange: () => void): () => void {
  assertSupabaseConfig();

  const channel = supabase
    .channel('score-states')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'score_states',
      },
      () => {
        onChange();
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

function scoreStateRowToEventSummary(row: ScoreStateRow): EventSummary {
  return {
    id: row.court_slug,
    title: row.title,
    courtName: row.court_name,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
