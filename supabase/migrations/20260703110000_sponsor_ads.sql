alter table public.score_events drop constraint if exists score_events_type_check;
alter table public.score_events
  add constraint score_events_type_check
  check (type in (
    'add_point',
    'undo',
    'reset',
    'manual_patch',
    'update_meta',
    'set_status',
    'new_match',
    'update_overlay',
    'use_card',
    'trigger_data_scene',
    'update_sponsor_ticker',
    'trigger_sponsor_ad'
  ));

create or replace function public.kpl_default_sponsor_ads()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'ticker', jsonb_build_object(
      'visible', false,
      'sponsorIds', jsonb_build_array(),
      'label', 'Patrocinadores oficiales',
      'speedSeconds', 28
    ),
    'fullscreen', null
  );
$$;

create or replace function public.kpl_normalize_sponsor_ids(p_ids jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_ids jsonb;
begin
  if coalesce(jsonb_typeof(p_ids), '') <> 'array' then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(id order by first_ordinality), '[]'::jsonb)
  into v_ids
  from (
    select id, min(ordinality) as first_ordinality
    from (
      select nullif(btrim(value #>> '{}'), '') as id, ordinality
      from jsonb_array_elements(p_ids) with ordinality
    ) raw_ids
    where id is not null
    group by id
  ) unique_ids;

  return v_ids;
end;
$$;

create or replace function public.kpl_normalize_sponsor_ticker(p_ticker jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_visible boolean := false;
  v_label text := 'Patrocinadores oficiales';
  v_speed int := 28;
begin
  if coalesce(jsonb_typeof(p_ticker), '') <> 'object' then
    return public.kpl_default_sponsor_ads() -> 'ticker';
  end if;

  if jsonb_typeof(p_ticker -> 'visible') = 'boolean' then
    v_visible := (p_ticker ->> 'visible')::boolean;
  end if;

  if nullif(btrim(coalesce(p_ticker ->> 'label', '')), '') is not null then
    v_label := btrim(p_ticker ->> 'label');
  end if;

  if jsonb_typeof(p_ticker -> 'speedSeconds') = 'number' then
    v_speed := least(90, greatest(12, round((p_ticker ->> 'speedSeconds')::numeric)::int));
  end if;

  return jsonb_build_object(
    'visible', v_visible,
    'sponsorIds', public.kpl_normalize_sponsor_ids(p_ticker -> 'sponsorIds'),
    'label', v_label,
    'speedSeconds', v_speed
  );
end;
$$;

create or replace function public.kpl_normalize_sponsor_fullscreen(p_fullscreen jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_sponsor_ids jsonb;
  v_legacy_sponsor_id text;
  v_duration int := 8;
begin
  if coalesce(jsonb_typeof(p_fullscreen), '') <> 'object' then
    return 'null'::jsonb;
  end if;

  v_sponsor_ids := public.kpl_normalize_sponsor_ids(p_fullscreen -> 'sponsorIds');
  v_legacy_sponsor_id := nullif(btrim(coalesce(p_fullscreen ->> 'sponsorId', '')), '');

  if jsonb_array_length(v_sponsor_ids) = 0 and v_legacy_sponsor_id is not null then
    v_sponsor_ids := jsonb_build_array(v_legacy_sponsor_id);
  end if;

  if jsonb_array_length(v_sponsor_ids) = 0 then
    return 'null'::jsonb;
  end if;

  if jsonb_typeof(p_fullscreen -> 'durationSeconds') = 'number' then
    v_duration := least(30, greatest(4, round((p_fullscreen ->> 'durationSeconds')::numeric)::int));
  end if;

  return jsonb_build_object(
    'id', coalesce(nullif(btrim(coalesce(p_fullscreen ->> 'id', '')), ''), v_sponsor_ids ->> 0),
    'sponsorIds', v_sponsor_ids,
    'triggeredAt', coalesce(p_fullscreen ->> 'triggeredAt', ''),
    'durationSeconds', v_duration
  );
end;
$$;

create or replace function public.kpl_normalize_sponsor_ads(p_ads jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'ticker', public.kpl_normalize_sponsor_ticker(p_ads -> 'ticker'),
    'fullscreen', public.kpl_normalize_sponsor_fullscreen(p_ads -> 'fullscreen')
  );
$$;

create or replace function public.kpl_state_with_sponsor_ad_defaults(p_state jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    p_state,
    '{sponsorAds}',
    public.kpl_normalize_sponsor_ads(p_state -> 'sponsorAds'),
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
    'cards', public.kpl_default_cards(),
    'dataScene', null,
    'sponsorAds', public.kpl_default_sponsor_ads(),
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
      'dataScene', null,
      'sponsorAds', jsonb_set(
        public.kpl_normalize_sponsor_ads(p_state -> 'sponsorAds'),
        '{fullscreen}',
        'null'::jsonb,
        true
      )
    );
$$;

create or replace function public.kpl_update_sponsor_ticker_state(
  p_state jsonb,
  p_patch jsonb
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_ads jsonb := public.kpl_normalize_sponsor_ads(p_state -> 'sponsorAds');
  v_ticker jsonb := v_ads -> 'ticker';
begin
  if coalesce(jsonb_typeof(p_patch), '') = 'object' then
    v_ticker := public.kpl_normalize_sponsor_ticker(v_ticker || p_patch);
  end if;

  v_ads := jsonb_set(v_ads, '{ticker}', v_ticker, true);
  return jsonb_set(p_state, '{sponsorAds}', v_ads, true);
end;
$$;

drop function if exists public.kpl_trigger_sponsor_fullscreen_state(jsonb, text, int, text);

create or replace function public.kpl_trigger_sponsor_fullscreen_state(
  p_state jsonb,
  p_sponsor_ids jsonb,
  p_duration_seconds int,
  p_command_id text
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_ads jsonb := public.kpl_normalize_sponsor_ads(p_state -> 'sponsorAds');
  v_now text := to_jsonb(now()) #>> '{}';
  v_sponsor_ids jsonb := public.kpl_normalize_sponsor_ids(p_sponsor_ids);
  v_duration int := least(30, greatest(4, coalesce(p_duration_seconds, 8)));
  v_fullscreen jsonb;
begin
  if jsonb_array_length(v_sponsor_ids) = 0 then
    v_fullscreen := 'null'::jsonb;
  else
    v_fullscreen := jsonb_build_object(
      'id', p_command_id,
      'sponsorIds', v_sponsor_ids,
      'triggeredAt', v_now,
      'durationSeconds', v_duration
    );
  end if;

  v_ads := jsonb_set(v_ads, '{fullscreen}', v_fullscreen, true);
  return jsonb_set(p_state, '{sponsorAds}', v_ads, true);
end;
$$;

update public.score_states
set state = public.kpl_state_with_sponsor_ad_defaults(state)
where
  state -> 'sponsorAds' is null
  or coalesce(jsonb_typeof(state -> 'sponsorAds'), '') <> 'object';

create or replace function public.update_sponsor_ticker(
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

  v_next := public.kpl_update_sponsor_ticker_state(v_ctx.state, p_patch);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'update_sponsor_ticker', null, 'Sponsors OBS', v_ctx.state, v_next);
end;
$$;

drop function if exists public.trigger_sponsor_fullscreen(text, int, text, text, int);

create or replace function public.trigger_sponsor_fullscreen(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_sponsor_ids jsonb,
  p_duration_seconds int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_next jsonb;
  v_label text := case
    when jsonb_array_length(public.kpl_normalize_sponsor_ids(p_sponsor_ids)) = 0 then 'Limpiar sponsor OBS'
    else 'Anuncio sponsors OBS'
  end;
begin
  select * into v_ctx from public.kpl_load_command_context(p_court_slug, p_expected_version, p_command_id);
  if v_ctx.duplicate then
    return v_ctx.state;
  end if;

  v_next := public.kpl_trigger_sponsor_fullscreen_state(v_ctx.state, p_sponsor_ids, p_duration_seconds, p_command_id);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'trigger_sponsor_ad', null, v_label, v_ctx.state, v_next);
end;
$$;

revoke all on function public.update_sponsor_ticker(text, int, text, jsonb) from public, anon;
revoke all on function public.trigger_sponsor_fullscreen(text, int, text, jsonb, int) from public, anon;
grant execute on function public.update_sponsor_ticker(text, int, text, jsonb) to authenticated;
grant execute on function public.trigger_sponsor_fullscreen(text, int, text, jsonb, int) to authenticated;
