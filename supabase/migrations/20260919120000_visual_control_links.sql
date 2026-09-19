-- Bearer links are scoped to one court. Only digests are stored.
create table public.visual_control_links (
  court_id uuid primary key references public.courts(id) on delete cascade,
  token_digest bytea not null,
  created_at timestamptz not null default now()
);
alter table public.visual_control_links enable row level security;
revoke all on public.visual_control_links from public, anon, authenticated;

create function public.create_visual_control_link(p_court_slug text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_court public.courts%rowtype;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  select * into strict v_court from public.courts where slug = p_court_slug;
  perform public.kpl_require_club_member(v_court.club_id);
  insert into public.visual_control_links(court_id, token_digest)
  values (v_court.id, sha256(convert_to(v_token, 'UTF8')))
  on conflict (court_id) do update set token_digest = excluded.token_digest, created_at = now();
  return v_token;
end;
$$;
grant execute on function public.create_visual_control_link(text) to authenticated;

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
set search_path = ''
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

  if current_setting('kpl.visual_court_id', true) = v_row.court_id::text then
    actor_id := null;
  else
    actor_id := public.kpl_require_club_member(v_row.club_id);
  end if;
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


create function public.visual_control_command(p_court_slug text, p_token text, p_action text, p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_court_id uuid;
  v_result jsonb;
  v_previous text := current_setting('kpl.visual_court_id', true);
  v_version int := (p_params->>'p_expected_version')::int;
  v_command text := p_params->>'p_command_id';
begin
  select c.id into v_court_id from public.courts c
  join public.visual_control_links l on l.court_id = c.id
  where c.slug = p_court_slug and length(p_token) = 64
    and l.token_digest = sha256(convert_to(p_token, 'UTF8'));
  if v_court_id is null then raise exception 'Enlace de control inválido o revocado.'; end if;
  perform set_config('kpl.visual_court_id', v_court_id::text, true);
  case p_action
    when 'state' then select state into v_result from public.score_states where court_id = v_court_id;
    when 'add_point' then v_result := public.add_point(p_court_slug, v_version, v_command, p_params->>'p_side');
    when 'undo_last' then v_result := public.undo_last(p_court_slug, v_version, v_command);
    when 'reset_match' then v_result := public.reset_match(p_court_slug, v_version, v_command);
    when 'manual_patch' then v_result := public.manual_patch(p_court_slug, v_version, v_command, p_params->'p_patch');
    when 'update_match_meta' then v_result := public.update_match_meta(p_court_slug, v_version, v_command, p_params->'p_patch');
    when 'set_match_status' then v_result := public.set_match_status(p_court_slug, v_version, v_command, p_params->>'p_status');
    when 'new_match' then v_result := public.new_match(p_court_slug, v_version, v_command, p_params->'p_setup');
    when 'update_overlay_settings' then v_result := public.update_overlay_settings(p_court_slug, v_version, v_command, p_params->'p_patch');
    when 'use_match_card' then v_result := public.use_match_card(p_court_slug, v_version, v_command, p_params->>'p_side', p_params->>'p_card_id', p_params->>'p_card_name');
    when 'trigger_overlay_data_scene' then v_result := public.trigger_overlay_data_scene(p_court_slug, v_version, v_command, p_params->>'p_kind', p_params->'p_target');
    when 'update_sponsor_ticker' then v_result := public.update_sponsor_ticker(p_court_slug, v_version, v_command, p_params->'p_patch');
    when 'trigger_sponsor_fullscreen' then v_result := public.trigger_sponsor_fullscreen(p_court_slug, v_version, v_command, p_params->'p_sponsor_ids', (p_params->>'p_duration_seconds')::int);
    else raise exception 'Comando de control no permitido.';
  end case;
  perform set_config('kpl.visual_court_id', coalesce(v_previous, ''), true);
  return v_result;
end;
$$;
grant execute on function public.visual_control_command(text, text, text, jsonb) to anon, authenticated;
