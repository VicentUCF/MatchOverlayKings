alter table public.score_events drop constraint if exists score_events_type_check;
alter table public.score_events
  add constraint score_events_type_check
  check (type in ('add_point', 'undo', 'reset', 'manual_patch', 'update_meta', 'set_status', 'new_match', 'update_overlay', 'use_card', 'trigger_data_scene'));

create or replace function public.kpl_default_cards()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'home', null,
    'away', null,
    'announcement', null
  );
$$;

create or replace function public.kpl_is_match_card_id(p_card_id text)
returns boolean
language sql
immutable
as $$
  select p_card_id in ('2vs1', 'restas-tu', 'cambiate', 'robo-saque', 'solo-un-saque', 'comodin', 'robo-carta');
$$;

create or replace function public.kpl_state_with_card_defaults(p_state jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    p_state,
    '{cards}',
    coalesce(p_state -> 'cards', public.kpl_default_cards()),
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
      'cards', public.kpl_default_cards()
    );
$$;

create or replace function public.kpl_use_card_state(
  p_state jsonb,
  p_side text,
  p_card_id text,
  p_card_name text,
  p_command_id text
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_state jsonb := public.kpl_state_with_card_defaults(p_state);
  v_cards jsonb := coalesce(v_state -> 'cards', public.kpl_default_cards());
  v_now text := to_jsonb(now()) #>> '{}';
  v_team_id text;
  v_card_name text := coalesce(nullif(btrim(p_card_name), ''), p_card_id);
  v_use jsonb;
begin
  if p_side not in ('home', 'away') then
    raise exception 'Side invalido.';
  end if;

  if v_state ->> 'status' <> 'live' then
    raise exception 'Las cartas solo se pueden lanzar con el partido en directo.';
  end if;

  if not public.kpl_is_match_card_id(p_card_id) then
    raise exception 'Carta no valida.';
  end if;

  if v_cards -> p_side is not null and v_cards -> p_side <> 'null'::jsonb then
    raise exception 'Ese equipo ya ha utilizado su carta.';
  end if;

  v_team_id := case when p_side = 'home' then v_state ->> 'homeTeamId' else v_state ->> 'awayTeamId' end;
  v_use := jsonb_build_object(
    'side', p_side,
    'teamId', v_team_id,
    'cardId', p_card_id,
    'cardName', v_card_name,
    'usedAt', v_now
  );
  v_cards := jsonb_set(v_cards, array[p_side], v_use, true);
  v_cards := jsonb_set(v_cards, '{announcement}', v_use || jsonb_build_object('id', p_command_id), true);

  return jsonb_set(v_state, '{cards}', v_cards, true);
end;
$$;

update public.score_states
set state = public.kpl_state_with_card_defaults(state)
where not state ? 'cards';

create or replace function public.use_match_card(
  p_court_slug text,
  p_expected_version int,
  p_command_id text,
  p_side text,
  p_card_id text,
  p_card_name text
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

  v_next := public.kpl_use_card_state(v_ctx.state, p_side, p_card_id, p_card_name, p_command_id);
  return public.kpl_store_state(v_ctx.court_id, v_ctx.actor_id, p_command_id, 'use_card', p_side, 'Carta ' || public.kpl_side_label(p_side), v_ctx.state, v_next);
end;
$$;

revoke all on function public.use_match_card(text, int, text, text, text, text) from public, anon;
grant execute on function public.use_match_card(text, int, text, text, text, text) to authenticated;
