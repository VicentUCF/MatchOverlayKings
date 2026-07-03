alter table public.score_events drop constraint if exists score_events_type_check;
alter table public.score_events
  add constraint score_events_type_check
  check (type in ('add_point', 'undo', 'reset', 'manual_patch', 'update_meta', 'set_status', 'new_match', 'update_overlay', 'use_card', 'trigger_data_scene', 'update_sponsor_ticker', 'trigger_sponsor_ad'));

create or replace function public.kpl_default_overlay_settings()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'visible', true,
    'size', 'standard',
    'position', 'top-left',
    'dataScenesAuto', false
  );
$$;

create or replace function public.kpl_normalize_overlay_settings(p_settings jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_visible boolean := true;
  v_size text := 'standard';
  v_position text := 'top-left';
  v_data_scenes_auto boolean := false;
begin
  if jsonb_typeof(p_settings -> 'visible') = 'boolean' then
    v_visible := (p_settings ->> 'visible')::boolean;
  end if;

  if p_settings ->> 'size' in ('compact', 'standard', 'large') then
    v_size := p_settings ->> 'size';
  end if;

  if p_settings ->> 'position' in ('top-left', 'center', 'bottom-center') then
    v_position := p_settings ->> 'position';
  end if;

  if jsonb_typeof(p_settings -> 'dataScenesAuto') = 'boolean' then
    v_data_scenes_auto := (p_settings ->> 'dataScenesAuto')::boolean;
  end if;

  return jsonb_build_object(
    'visible', v_visible,
    'size', v_size,
    'position', v_position,
    'dataScenesAuto', v_data_scenes_auto
  );
end;
$$;

create or replace function public.kpl_state_with_overlay_defaults(p_state jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    jsonb_set(
      p_state,
      '{overlaySettings}',
      public.kpl_normalize_overlay_settings(p_state -> 'overlaySettings'),
      true
    ),
    '{dataScene}',
    coalesce(p_state -> 'dataScene', 'null'::jsonb),
    true
  );
$$;

create or replace function public.kpl_is_data_scene_kind(p_kind text)
returns boolean
language sql
immutable
as $$
  select p_kind in ('standings', 'player-ranking', 'team-roster', 'calendar', 'upcoming-matches', 'latest-results');
$$;

create or replace function public.kpl_normalize_data_scene_target(p_target jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_team_id text;
begin
  if jsonb_typeof(p_target) <> 'object' then
    return jsonb_build_object('type', 'league');
  end if;

  if p_target ->> 'type' = 'side' then
    return jsonb_build_object(
      'type', 'side',
      'side', case when p_target ->> 'side' = 'away' then 'away' else 'home' end
    );
  end if;

  if p_target ->> 'type' = 'team' then
    v_team_id := nullif(btrim(coalesce(p_target ->> 'teamId', '')), '');

    if v_team_id is not null then
      return jsonb_build_object('type', 'team', 'teamId', v_team_id);
    end if;
  end if;

  return jsonb_build_object('type', 'league');
end;
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
    'overlaySettings', public.kpl_default_overlay_settings(),
    'cards', public.kpl_default_cards(),
    'dataScene', null,
    'history', '[]'::jsonb,
    'version', 1,
    'updatedAt', v_now
  );
end;
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
      'winner', null,
      'cards', public.kpl_default_cards(),
      'dataScene', null
    );
$$;

create or replace function public.kpl_trigger_data_scene_state(
  p_state jsonb,
  p_kind text,
  p_target jsonb,
  p_command_id text
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_now text := to_jsonb(now()) #>> '{}';
begin
  if not public.kpl_is_data_scene_kind(p_kind) then
    raise exception 'Escena de datos no valida.';
  end if;

  return jsonb_set(
    public.kpl_state_with_overlay_defaults(p_state),
    '{dataScene}',
    jsonb_build_object(
      'id', p_command_id,
      'kind', p_kind,
      'target', public.kpl_normalize_data_scene_target(p_target),
      'triggeredAt', v_now
    ),
    true
  );
end;
$$;

update public.score_states
set state = public.kpl_state_with_overlay_defaults(state)
where
  state -> 'overlaySettings' -> 'dataScenesAuto' is null
  or not state ? 'dataScene';

create or replace function public.trigger_overlay_data_scene(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_kind text,
  p_target jsonb
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

  v_next := public.kpl_trigger_data_scene_state(v_ctx.state, p_kind, p_target, p_command_id);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'trigger_data_scene', null, 'Escena datos OBS', v_ctx.state, v_next);
end;
$$;

revoke all on function public.trigger_overlay_data_scene(text, int, text, text, jsonb) from public, anon;
grant execute on function public.trigger_overlay_data_scene(text, int, text, text, jsonb) to authenticated;
