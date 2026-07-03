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
    'position', 'top-left'
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

  return jsonb_build_object(
    'visible', v_visible,
    'size', v_size,
    'position', v_position
  );
end;
$$;

create or replace function public.kpl_state_with_overlay_defaults(p_state jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    p_state,
    '{overlaySettings}',
    public.kpl_normalize_overlay_settings(p_state -> 'overlaySettings'),
    true
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
    'overlaySettings', public.kpl_default_overlay_settings(),
    'history', '[]'::jsonb,
    'version', 1,
    'updatedAt', v_now
  );
end;
$$;

create or replace function public.kpl_update_overlay_settings_state(p_state jsonb, p_patch jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_current jsonb := public.kpl_normalize_overlay_settings(p_state -> 'overlaySettings');
  v_next jsonb := public.kpl_normalize_overlay_settings(v_current || coalesce(p_patch, '{}'::jsonb));
begin
  return jsonb_set(p_state, '{overlaySettings}', v_next, true);
end;
$$;

update public.score_states
set state = public.kpl_state_with_overlay_defaults(state)
where not state ? 'overlaySettings';

create or replace function public.update_overlay_settings(
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

  v_next := public.kpl_update_overlay_settings_state(v_ctx.state, p_patch);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'update_overlay', null, 'Actualizar OBS', v_ctx.state, v_next);
end;
$$;

revoke all on function public.update_overlay_settings(text, int, text, jsonb) from public, anon;
grant execute on function public.update_overlay_settings(text, int, text, jsonb) to authenticated;
