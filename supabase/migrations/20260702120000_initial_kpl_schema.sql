create extension if not exists pgcrypto;

create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.club_users (
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin')),
  created_at timestamptz not null default now(),
  primary key (club_id, user_id)
);

create table if not exists public.teams (
  id text primary key,
  club_id uuid not null references public.clubs(id) on delete cascade,
  name text not null,
  short_name text not null,
  logo_url text not null,
  primary_color text not null,
  secondary_color text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.courts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  slug text not null unique,
  name text not null,
  display_order int not null,
  created_at timestamptz not null default now()
);

create table if not exists public.score_states (
  court_id uuid primary key references public.courts(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  court_slug text not null unique,
  title text not null,
  court_name text not null,
  home_team_id text not null references public.teams(id),
  away_team_id text not null references public.teams(id),
  status text not null check (status in ('pre_match', 'live', 'finished')),
  version int not null default 1 check (version > 0),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.score_events (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  command_id text not null,
  type text not null check (type in ('add_point', 'undo', 'reset', 'manual_patch', 'update_meta', 'set_status', 'new_match')),
  side text check (side in ('home', 'away')),
  label text not null,
  before jsonb not null,
  after jsonb not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  unique (court_id, command_id)
);

alter table public.clubs enable row level security;
alter table public.club_users enable row level security;
alter table public.teams enable row level security;
alter table public.courts enable row level security;
alter table public.score_states enable row level security;
alter table public.score_events enable row level security;

drop policy if exists "clubs readable by members" on public.clubs;
create policy "clubs readable by members"
  on public.clubs for select
  to authenticated
  using (
    exists (
      select 1
      from public.club_users cu
      where cu.club_id = clubs.id
        and cu.user_id = auth.uid()
    )
  );

drop policy if exists "club users readable by themselves" on public.club_users;
create policy "club users readable by themselves"
  on public.club_users for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "teams public read" on public.teams;
create policy "teams public read"
  on public.teams for select
  to anon, authenticated
  using (true);

drop policy if exists "courts readable by members" on public.courts;
create policy "courts readable by members"
  on public.courts for select
  to authenticated
  using (
    exists (
      select 1
      from public.club_users cu
      where cu.club_id = courts.club_id
        and cu.user_id = auth.uid()
    )
  );

drop policy if exists "score states public live or member read" on public.score_states;
create policy "score states public live or member read"
  on public.score_states for select
  to anon, authenticated
  using (
    status = 'live'
    or exists (
      select 1
      from public.club_users cu
      where cu.club_id = score_states.club_id
        and cu.user_id = auth.uid()
    )
  );

drop policy if exists "score events readable by members" on public.score_events;
create policy "score events readable by members"
  on public.score_events for select
  to authenticated
  using (
    exists (
      select 1
      from public.club_users cu
      where cu.club_id = score_events.club_id
        and cu.user_id = auth.uid()
    )
  );

create or replace function public.kpl_empty_lineups()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'home', jsonb_build_object('player1', '', 'player2', ''),
    'away', jsonb_build_object('player1', '', 'player2', '')
  );
$$;

create or replace function public.kpl_default_config()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'setsToWin', 2,
    'gamesPerSet', 6,
    'tieBreakAt', 6,
    'tieBreakTarget', 7,
    'tieBreakWinBy', 2,
    'deuceMode', 'golden-point'
  );
$$;

create or replace function public.kpl_create_active_set()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'homeGames', 0,
    'awayGames', 0,
    'status', 'active',
    'winner', null,
    'tieBreak', null
  );
$$;

create or replace function public.kpl_create_game(p_is_tie_break boolean)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'homePoints', 0,
    'awayPoints', 0,
    'isTieBreak', p_is_tie_break
  );
$$;

create or replace function public.kpl_create_initial_state(
  p_id text,
  p_title text,
  p_home_team_id text,
  p_away_team_id text,
  p_lineups jsonb,
  p_serving_side text,
  p_court_name text,
  p_status text,
  p_config jsonb
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_now text := to_jsonb(now()) #>> '{}';
begin
  return jsonb_build_object(
    'id', p_id,
    'title', p_title,
    'homeTeamId', p_home_team_id,
    'awayTeamId', p_away_team_id,
    'lineups', coalesce(p_lineups, public.kpl_empty_lineups()),
    'servingSide', case when p_serving_side = 'away' then 'away' else 'home' end,
    'courtName', p_court_name,
    'status', p_status,
    'config', coalesce(p_config, public.kpl_default_config()),
    'sets', jsonb_build_array(public.kpl_create_active_set()),
    'currentGame', public.kpl_create_game(false),
    'winner', null,
    'history', '[]'::jsonb,
    'version', 1,
    'updatedAt', v_now
  );
end;
$$;

create or replace function public.kpl_score_snapshot(p_state jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'status', p_state -> 'status',
    'sets', p_state -> 'sets',
    'currentGame', p_state -> 'currentGame',
    'winner', p_state -> 'winner'
  );
$$;

create or replace function public.kpl_opposite_side(p_side text)
returns text
language sql
immutable
as $$
  select case when p_side = 'home' then 'away' else 'home' end;
$$;

create or replace function public.kpl_side_label(p_side text)
returns text
language sql
immutable
as $$
  select case when p_side = 'home' then 'local' else 'visitante' end;
$$;

create or replace function public.kpl_active_set_index(p_state jsonb)
returns int
language plpgsql
immutable
as $$
declare
  v_set jsonb;
  v_ord bigint;
begin
  for v_set, v_ord in
    select value, ordinality
    from jsonb_array_elements(p_state -> 'sets') with ordinality
  loop
    if v_set ->> 'status' = 'active' then
      return (v_ord - 1)::int;
    end if;
  end loop;

  raise exception 'No hay set activo.';
end;
$$;

create or replace function public.kpl_completed_set_count(p_sets jsonb, p_side text)
returns int
language sql
immutable
as $$
  select count(*)::int
  from jsonb_array_elements(p_sets) as item(value)
  where value ->> 'status' = 'complete'
    and value ->> 'winner' = p_side;
$$;

create or replace function public.kpl_is_game_complete(p_game jsonb, p_config jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_home int := (p_game ->> 'homePoints')::int;
  v_away int := (p_game ->> 'awayPoints')::int;
  v_max int := greatest(v_home, v_away);
  v_diff int := abs(v_home - v_away);
begin
  if p_config ->> 'deuceMode' = 'golden-point' then
    return v_max >= 4;
  end if;

  return v_max >= 4 and v_diff >= 2;
end;
$$;

create or replace function public.kpl_is_set_complete(p_set jsonb, p_config jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_home int := (p_set ->> 'homeGames')::int;
  v_away int := (p_set ->> 'awayGames')::int;
  v_max int := greatest(v_home, v_away);
  v_diff int := abs(v_home - v_away);
begin
  return v_max >= (p_config ->> 'gamesPerSet')::int and v_diff >= 2;
end;
$$;

create or replace function public.kpl_should_play_tie_break(p_set jsonb, p_config jsonb)
returns boolean
language sql
immutable
as $$
  select (p_set ->> 'homeGames')::int = (p_config ->> 'tieBreakAt')::int
     and (p_set ->> 'awayGames')::int = (p_config ->> 'tieBreakAt')::int;
$$;

create or replace function public.kpl_complete_set_state(
  p_state jsonb,
  p_active_idx int,
  p_active_set jsonb,
  p_winner text
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
  v_sets jsonb := p_state -> 'sets';
  v_config jsonb := p_state -> 'config';
  v_won_sets int;
begin
  p_active_set := jsonb_set(p_active_set, '{status}', to_jsonb('complete'::text), false);
  p_active_set := jsonb_set(p_active_set, '{winner}', to_jsonb(p_winner), false);
  v_sets := jsonb_set(v_sets, array[p_active_idx::text], p_active_set, false);
  v_state := jsonb_set(v_state, '{sets}', v_sets, false);
  v_won_sets := public.kpl_completed_set_count(v_sets, p_winner);

  if v_won_sets >= (v_config ->> 'setsToWin')::int then
    v_state := jsonb_set(v_state, '{winner}', to_jsonb(p_winner), false);
    v_state := jsonb_set(v_state, '{status}', to_jsonb('finished'::text), false);
    v_state := jsonb_set(v_state, '{currentGame}', public.kpl_create_game(false), false);
    return v_state;
  end if;

  v_sets := v_sets || jsonb_build_array(public.kpl_create_active_set());
  v_state := jsonb_set(v_state, '{sets}', v_sets, false);
  v_state := jsonb_set(v_state, '{currentGame}', public.kpl_create_game(false), false);
  return v_state;
end;
$$;

create or replace function public.kpl_award_game_state(p_state jsonb, p_side text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
  v_idx int := public.kpl_active_set_index(p_state);
  v_sets jsonb := p_state -> 'sets';
  v_set jsonb := v_sets -> v_idx;
  v_game_key text := p_side || 'Games';
  v_games int := (v_set ->> v_game_key)::int + 1;
begin
  v_set := jsonb_set(v_set, array[v_game_key], to_jsonb(v_games), false);

  if public.kpl_is_set_complete(v_set, p_state -> 'config') then
    return public.kpl_complete_set_state(v_state, v_idx, v_set, p_side);
  end if;

  v_sets := jsonb_set(v_sets, array[v_idx::text], v_set, false);
  v_state := jsonb_set(v_state, '{sets}', v_sets, false);
  v_state := jsonb_set(
    v_state,
    '{currentGame}',
    public.kpl_create_game(public.kpl_should_play_tie_break(v_set, p_state -> 'config')),
    false
  );
  return v_state;
end;
$$;

create or replace function public.kpl_add_tie_break_point_state(p_state jsonb, p_side text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
  v_idx int := public.kpl_active_set_index(p_state);
  v_sets jsonb := p_state -> 'sets';
  v_set jsonb := v_sets -> v_idx;
  v_game jsonb := p_state -> 'currentGame';
  v_point_key text := p_side || 'Points';
  v_side_points int;
  v_opponent_points int;
begin
  v_side_points := (v_game ->> v_point_key)::int + 1;
  v_game := jsonb_set(v_game, array[v_point_key], to_jsonb(v_side_points), false);
  v_state := jsonb_set(v_state, '{currentGame}', v_game, false);
  v_opponent_points := (v_game ->> (public.kpl_opposite_side(p_side) || 'Points'))::int;

  if v_side_points < ((p_state -> 'config') ->> 'tieBreakTarget')::int
    or v_side_points - v_opponent_points < ((p_state -> 'config') ->> 'tieBreakWinBy')::int then
    return v_state;
  end if;

  v_set := jsonb_set(v_set, array[p_side || 'Games'], to_jsonb((v_set ->> (p_side || 'Games'))::int + 1), false);
  v_set := jsonb_set(
    v_set,
    '{tieBreak}',
    jsonb_build_object(
      'homePoints', (v_game ->> 'homePoints')::int,
      'awayPoints', (v_game ->> 'awayPoints')::int,
      'winner', p_side
    ),
    false
  );

  return public.kpl_complete_set_state(v_state, v_idx, v_set, p_side);
end;
$$;

create or replace function public.kpl_add_point_state(p_state jsonb, p_side text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
  v_game jsonb;
  v_point_key text := p_side || 'Points';
begin
  if p_side not in ('home', 'away') then
    raise exception 'Side invalido.';
  end if;

  if p_state ->> 'status' = 'finished' or p_state ->> 'winner' in ('home', 'away') then
    raise exception 'El partido ya esta finalizado.';
  end if;

  v_state := jsonb_set(v_state, '{status}', to_jsonb('live'::text), false);

  if (v_state #>> '{currentGame,isTieBreak}')::boolean then
    return public.kpl_add_tie_break_point_state(v_state, p_side);
  end if;

  v_game := v_state -> 'currentGame';
  v_game := jsonb_set(v_game, array[v_point_key], to_jsonb((v_game ->> v_point_key)::int + 1), false);
  v_state := jsonb_set(v_state, '{currentGame}', v_game, false);

  if public.kpl_is_game_complete(v_game, v_state -> 'config') then
    return public.kpl_award_game_state(v_state, p_side);
  end if;

  return v_state;
end;
$$;

create or replace function public.kpl_apply_snapshot_state(p_state jsonb, p_snapshot jsonb)
returns jsonb
language sql
immutable
as $$
  select p_state
    || jsonb_build_object(
      'status', p_snapshot -> 'status',
      'sets', p_snapshot -> 'sets',
      'currentGame', p_snapshot -> 'currentGame',
      'winner', p_snapshot -> 'winner'
    );
$$;

create or replace function public.kpl_reset_state(p_state jsonb)
returns jsonb
language sql
immutable
as $$
  select p_state
    || jsonb_build_object(
      'status', 'pre_match',
      'sets', jsonb_build_array(public.kpl_create_active_set()),
      'currentGame', public.kpl_create_game(false),
      'winner', null
    );
$$;

create or replace function public.kpl_update_meta_state(p_state jsonb, p_patch jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
  v_title text;
  v_court_name text;
begin
  if p_patch ? 'title' then
    v_title := nullif(btrim(p_patch ->> 'title'), '');
    if v_title is not null then
      v_state := jsonb_set(v_state, '{title}', to_jsonb(v_title), false);
    end if;
  end if;

  if p_patch ? 'homeTeamId' then
    v_state := jsonb_set(v_state, '{homeTeamId}', to_jsonb(p_patch ->> 'homeTeamId'), false);
  end if;

  if p_patch ? 'awayTeamId' then
    v_state := jsonb_set(v_state, '{awayTeamId}', to_jsonb(p_patch ->> 'awayTeamId'), false);
  end if;

  if p_patch ? 'lineups' then
    v_state := jsonb_set(v_state, '{lineups}', coalesce(p_patch -> 'lineups', public.kpl_empty_lineups()), false);
  end if;

  if p_patch ? 'servingSide' then
    v_state := jsonb_set(v_state, '{servingSide}', to_jsonb(case when p_patch ->> 'servingSide' = 'away' then 'away' else 'home' end), false);
  end if;

  if p_patch ? 'courtName' then
    v_court_name := btrim(p_patch ->> 'courtName');
    v_state := jsonb_set(v_state, '{courtName}', to_jsonb(v_court_name), false);
  end if;

  return v_state;
end;
$$;

create or replace function public.kpl_manual_patch_state(p_state jsonb, p_patch jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
  v_active_sets int;
begin
  if p_patch ? 'status' then
    v_state := jsonb_set(v_state, '{status}', p_patch -> 'status', false);
  end if;

  if p_patch ? 'sets' then
    v_state := jsonb_set(v_state, '{sets}', p_patch -> 'sets', false);
  end if;

  if p_patch ? 'currentGame' then
    v_state := jsonb_set(v_state, '{currentGame}', p_patch -> 'currentGame', false);
  end if;

  if p_patch ? 'winner' then
    v_state := jsonb_set(v_state, '{winner}', p_patch -> 'winner', false);
  end if;

  if jsonb_array_length(v_state -> 'sets') = 0 then
    raise exception 'El marcador necesita al menos un set.';
  end if;

  select count(*)::int into v_active_sets
  from jsonb_array_elements(v_state -> 'sets') as item(value)
  where value ->> 'status' = 'active';

  if v_state ->> 'status' <> 'finished' and v_active_sets <> 1 then
    raise exception 'El partido debe tener un set activo.';
  end if;

  if (v_state #>> '{currentGame,homePoints}')::int < 0 or (v_state #>> '{currentGame,awayPoints}')::int < 0 then
    raise exception 'Los puntos no pueden ser negativos.';
  end if;

  return v_state;
end;
$$;

create or replace function public.kpl_undo_state(p_state jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_entry jsonb;
begin
  for v_entry in
    select value
    from jsonb_array_elements(coalesce(p_state -> 'history', '[]'::jsonb)) as item(value)
    where value ->> 'type' in ('add_point', 'manual_patch', 'reset')
    order by (value ->> 'createdAt') desc
  loop
    return public.kpl_apply_snapshot_state(p_state, v_entry -> 'before');
  end loop;

  return p_state;
end;
$$;

create or replace function public.kpl_set_status_state(p_state jsonb, p_status text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_state;
begin
  if p_status not in ('pre_match', 'live', 'finished') then
    raise exception 'status invalido.';
  end if;

  v_state := jsonb_set(v_state, '{status}', to_jsonb(p_status), false);

  if p_status <> 'finished' then
    v_state := jsonb_set(v_state, '{winner}', 'null'::jsonb, false);
  end if;

  return v_state;
end;
$$;

create or replace function public.kpl_store_state(
  p_court_id uuid,
  p_actor_id uuid,
  p_command_id text,
  p_type text,
  p_side text,
  p_label text,
  p_old_state jsonb,
  p_draft jsonb,
  p_reset_history boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now text := to_jsonb(now()) #>> '{}';
  v_version int := coalesce((p_old_state ->> 'version')::int, 0) + 1;
  v_before jsonb := public.kpl_score_snapshot(p_old_state);
  v_after jsonb := public.kpl_score_snapshot(p_draft);
  v_entry jsonb;
  v_history jsonb;
  v_next jsonb;
  v_club_id uuid;
begin
  select club_id into v_club_id
  from public.score_states
  where court_id = p_court_id;

  v_entry := jsonb_build_object(
    'id', (p_old_state ->> 'id') || '-' || v_version || '-' || p_type,
    'commandId', p_command_id,
    'type', p_type,
    'side', p_side,
    'label', p_label,
    'before', v_before,
    'after', v_after,
    'createdAt', v_now
  );

  if p_reset_history then
    v_history := jsonb_build_array(v_entry);
  else
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into v_history
    from (
      select value, ordinality
      from jsonb_array_elements(coalesce(p_draft -> 'history', '[]'::jsonb) || jsonb_build_array(v_entry)) with ordinality
      order by ordinality desc
      limit 80
    ) kept;
  end if;

  v_next := p_draft || jsonb_build_object(
    'history', v_history,
    'version', v_version,
    'updatedAt', v_now
  );

  update public.score_states
  set
    title = v_next ->> 'title',
    court_name = v_next ->> 'courtName',
    home_team_id = v_next ->> 'homeTeamId',
    away_team_id = v_next ->> 'awayTeamId',
    status = v_next ->> 'status',
    version = v_version,
    updated_at = now(),
    state = v_next
  where court_id = p_court_id;

  insert into public.score_events (
    court_id,
    club_id,
    actor_id,
    command_id,
    type,
    side,
    label,
    before,
    after,
    state
  )
  values (
    p_court_id,
    v_club_id,
    p_actor_id,
    p_command_id,
    p_type,
    p_side,
    p_label,
    v_before,
    v_after,
    v_next
  )
  on conflict (court_id, command_id) do nothing;

  return v_next;
end;
$$;

create or replace function public.kpl_require_club_member(p_club_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.club_users cu
    where cu.club_id = p_club_id
      and cu.user_id = v_user_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return v_user_id;
end;
$$;

create or replace function public.kpl_load_command_context(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  out court_id uuid,
  out club_id uuid,
  out actor_id uuid,
  out state jsonb,
  out duplicate boolean
)
returns record
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.score_states%rowtype;
begin
  if nullif(btrim(p_command_id), '') is null then
    raise exception 'command_id requerido.';
  end if;

  select * into v_row
  from public.score_states ss
  where ss.court_slug = p_court_slug
  for update;

  if not found then
    raise exception 'Pista no encontrada.';
  end if;

  actor_id := public.kpl_require_club_member(v_row.club_id);
  court_id := v_row.court_id;
  club_id := v_row.club_id;
  state := v_row.state;

  duplicate := exists (
    select 1
    from public.score_events se
    where se.court_id = v_row.court_id
      and se.command_id = p_command_id
  );

  if duplicate then
    return;
  end if;

  if v_row.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT:%', v_row.version;
  end if;
end;
$$;

create or replace function public.add_point(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_side text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_add_point_state(v_ctx.state, p_side);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'add_point', p_side, 'Punto ' || public.kpl_side_label(p_side), v_ctx.state, v_next);
end;
$$;

create or replace function public.undo_last(
  p_court_slug text,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_undo_state(v_ctx.state);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'undo', null, 'Deshacer ultima accion', v_ctx.state, v_next);
end;
$$;

create or replace function public.reset_match(
  p_court_slug text,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_reset_state(v_ctx.state);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'reset', null, 'Reiniciar marcador', v_ctx.state, v_next);
end;
$$;

create or replace function public.manual_patch(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_manual_patch_state(v_ctx.state, p_patch);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'manual_patch', null, 'Correccion manual', v_ctx.state, v_next);
end;
$$;

create or replace function public.update_match_meta(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_update_meta_state(v_ctx.state, p_patch);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'update_meta', null, 'Actualizar partido', v_ctx.state, v_next);
end;
$$;

create or replace function public.set_match_status(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_set_status_state(v_ctx.state, p_status);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'set_status', null, 'Estado ' || p_status, v_ctx.state, v_next);
end;
$$;

create or replace function public.new_match(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_setup jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_reset_state(public.kpl_update_meta_state(v_ctx.state, p_setup));
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'new_match', null, 'Nueva partida', v_ctx.state, v_next, true);
end;
$$;

create or replace function public.claim_default_club()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_club_id uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select id into v_club_id
  from public.clubs
  where slug = 'kpl'
  limit 1;

  if v_club_id is null then
    raise exception 'Club por defecto no encontrado.';
  end if;

  if not exists (select 1 from public.club_users where club_id = v_club_id) then
    insert into public.club_users (club_id, user_id, role)
    values (v_club_id, v_user_id, 'admin')
    on conflict do nothing;
  end if;

  if not exists (
    select 1
    from public.club_users
    where club_id = v_club_id
      and user_id = v_user_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return v_club_id;
end;
$$;

revoke all on function public.claim_default_club() from public, anon;
revoke all on function public.add_point(text, int, text, text) from public, anon;
revoke all on function public.undo_last(text, int, text) from public, anon;
revoke all on function public.reset_match(text, int, text) from public, anon;
revoke all on function public.manual_patch(text, int, text, jsonb) from public, anon;
revoke all on function public.update_match_meta(text, int, text, jsonb) from public, anon;
revoke all on function public.set_match_status(text, int, text, text) from public, anon;
revoke all on function public.new_match(text, int, text, jsonb) from public, anon;

grant execute on function public.claim_default_club() to authenticated;
grant execute on function public.add_point(text, int, text, text) to authenticated;
grant execute on function public.undo_last(text, int, text) to authenticated;
grant execute on function public.reset_match(text, int, text) to authenticated;
grant execute on function public.manual_patch(text, int, text, jsonb) to authenticated;
grant execute on function public.update_match_meta(text, int, text, jsonb) to authenticated;
grant execute on function public.set_match_status(text, int, text, text) to authenticated;
grant execute on function public.new_match(text, int, text, jsonb) to authenticated;

insert into public.clubs (id, slug, name)
values ('00000000-0000-4000-8000-000000000001', 'kpl', 'KingsPadelLeague')
on conflict (slug) do update set name = excluded.name;

insert into public.teams (id, club_id, name, short_name, logo_url, primary_color, secondary_color)
values
  ('kings-of-favar', '00000000-0000-4000-8000-000000000001', 'Kings of Favar', 'Kings', '/logos/kings.png', '#D1007A', '#0F1115'),
  ('red-lions', '00000000-0000-4000-8000-000000000001', 'Red Lions', 'Red Lions', '/logos/red-lions.png', '#E21A23', '#14151A'),
  ('barbaridad-team', '00000000-0000-4000-8000-000000000001', 'Barbaridad Team', 'Barbaridad', '/logos/barbaridad.webp', '#F4B000', '#17120A'),
  ('magic-city', '00000000-0000-4000-8000-000000000001', 'Magic City', 'Magic', '/logos/magic-city.webp', '#20B8F0', '#15131C'),
  ('thormentadores', '00000000-0000-4000-8000-000000000001', 'Thormentadores', 'Thormen.', '/logos/thormentadores.png', '#8E44FF', '#0E1018'),
  ('titanics', '00000000-0000-4000-8000-000000000001', 'Titanics', 'Titanics', '/logos/titanics.png', '#1C7C54', '#101512')
on conflict (id) do update set
  name = excluded.name,
  short_name = excluded.short_name,
  logo_url = excluded.logo_url,
  primary_color = excluded.primary_color,
  secondary_color = excluded.secondary_color;

insert into public.courts (club_id, slug, name, display_order)
values
  ('00000000-0000-4000-8000-000000000001', 'pista-1', 'Pista 1', 1),
  ('00000000-0000-4000-8000-000000000001', 'pista-2', 'Pista 2', 2),
  ('00000000-0000-4000-8000-000000000001', 'pista-3', 'Pista 3', 3),
  ('00000000-0000-4000-8000-000000000001', 'pista-4', 'Pista 4', 4)
on conflict (slug) do update set
  name = excluded.name,
  display_order = excluded.display_order;

insert into public.score_states (
  court_id,
  club_id,
  court_slug,
  title,
  court_name,
  home_team_id,
  away_team_id,
  status,
  version,
  state
)
select
  c.id,
  c.club_id,
  c.slug,
  'Partido ' || c.name,
  c.name,
  case c.slug
    when 'pista-1' then 'kings-of-favar'
    when 'pista-2' then 'barbaridad-team'
    when 'pista-3' then 'thormentadores'
    else 'kings-of-favar'
  end,
  case c.slug
    when 'pista-1' then 'red-lions'
    when 'pista-2' then 'magic-city'
    when 'pista-3' then 'titanics'
    else 'magic-city'
  end,
  'pre_match',
  1,
  public.kpl_create_initial_state(
    c.slug,
    'Partido ' || c.name,
    case c.slug
      when 'pista-1' then 'kings-of-favar'
      when 'pista-2' then 'barbaridad-team'
      when 'pista-3' then 'thormentadores'
      else 'kings-of-favar'
    end,
    case c.slug
      when 'pista-1' then 'red-lions'
      when 'pista-2' then 'magic-city'
      when 'pista-3' then 'titanics'
      else 'magic-city'
    end,
    public.kpl_empty_lineups(),
    'home',
    c.name,
    'pre_match',
    public.kpl_default_config()
  )
from public.courts c
where c.slug in ('pista-1', 'pista-2', 'pista-3', 'pista-4')
on conflict (court_id) do nothing;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'score_states'
    ) then
      alter publication supabase_realtime add table public.score_states;
    end if;
  end if;
end $$;
