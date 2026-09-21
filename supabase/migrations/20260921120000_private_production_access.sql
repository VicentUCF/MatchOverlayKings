-- A match can be active for the compositor without being visible on the public site.
alter table public.score_states
  add column if not exists exposure text not null default 'public'
  check (exposure in ('internal', 'public'));

drop policy if exists "score states public live or member read" on public.score_states;
create policy "score states public live or member read"
  on public.score_states for select
  to anon, authenticated
  using (
    (status = 'live' and exposure = 'public')
    or exists (
      select 1 from public.club_users cu
      where cu.club_id = score_states.club_id and cu.user_id = auth.uid()
    )
  );

-- Tokens are never stored in clear text. Grants are independently revocable and
-- retain the season/matchday scope used for audit and automatic expiry.
create table public.visual_access_grants (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  scope text not null check (scope in ('operator_control', 'overlay_read')),
  season_label text not null,
  matchday_number int not null check (matchday_number > 0),
  token_digest bytea not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index visual_access_grants_active_idx
  on public.visual_access_grants(court_id, scope, expires_at)
  where revoked_at is null;
alter table public.visual_access_grants enable row level security;
revoke all on public.visual_access_grants from public, anon, authenticated;

create function public.configure_pilot_access(
  p_court_slug text,
  p_kind text,
  p_season_label text,
  p_matchday_number int
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_court public.courts%rowtype;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if p_kind not in ('recording', 'live') or p_matchday_number < 1 or nullif(btrim(p_season_label), '') is null then
    raise exception 'Configuración de acceso no válida.';
  end if;
  select * into strict v_court from public.courts where slug = p_court_slug;
  perform public.production_require_human_admin(v_court.club_id);
  update public.score_states set exposure = case when p_kind = 'recording' then 'internal' else 'public' end
    where court_id = v_court.id;
  delete from public.visual_access_grants where expires_at <= now();
  insert into public.visual_access_grants(court_id, scope, season_label, matchday_number, token_digest, expires_at)
    values (v_court.id, 'overlay_read', btrim(p_season_label), p_matchday_number,
      sha256(convert_to(v_token, 'UTF8')), now() + interval '24 hours');
  return jsonb_build_object('token', v_token, 'expiresAt', now() + interval '24 hours');
end;
$$;
revoke all on function public.configure_pilot_access(text, text, text, int) from public, anon;
grant execute on function public.configure_pilot_access(text, text, text, int) to authenticated;

create function public.create_visual_control_link(p_court_slug text, p_season_label text, p_matchday_number int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_court public.courts%rowtype;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires timestamptz := now() + interval '18 hours';
begin
  if p_matchday_number < 1 or nullif(btrim(p_season_label), '') is null then raise exception 'Jornada no válida.'; end if;
  select * into strict v_court from public.courts where slug = p_court_slug;
  perform public.production_require_human_admin(v_court.club_id);
  update public.visual_access_grants set revoked_at = now()
    where court_id = v_court.id and scope = 'operator_control' and revoked_at is null;
  insert into public.visual_access_grants(court_id, scope, season_label, matchday_number, token_digest, expires_at)
    values (v_court.id, 'operator_control', btrim(p_season_label), p_matchday_number,
      sha256(convert_to(v_token, 'UTF8')), v_expires);
  return jsonb_build_object('token', v_token, 'expiresAt', v_expires);
end;
$$;
revoke all on function public.create_visual_control_link(text, text, int) from public, anon;
grant execute on function public.create_visual_control_link(text, text, int) to authenticated;

-- Keep the previous RPC contract during rollout. It now creates the same
-- expiring scoped grant, so older admin bundles do not create permanent links.
create or replace function public.create_visual_control_link(p_court_slug text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_court public.courts%rowtype;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  select * into strict v_court from public.courts where slug = p_court_slug;
  perform public.production_require_human_admin(v_court.club_id);
  update public.visual_access_grants set revoked_at = now()
    where court_id = v_court.id and scope = 'operator_control' and revoked_at is null;
  insert into public.visual_access_grants(court_id, scope, season_label, matchday_number, token_digest, expires_at)
    values (v_court.id, 'operator_control', 'legacy', 1, sha256(convert_to(v_token, 'UTF8')), now() + interval '18 hours');
  return v_token;
end;
$$;
revoke all on function public.create_visual_control_link(text) from public, anon;
grant execute on function public.create_visual_control_link(text) to authenticated;

create function public.revoke_visual_control_link(p_court_slug text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_court public.courts%rowtype;
begin
  select * into strict v_court from public.courts where slug = p_court_slug;
  perform public.production_require_human_admin(v_court.club_id);
  update public.visual_access_grants set revoked_at = now()
    where court_id = v_court.id and scope = 'operator_control' and revoked_at is null;
end;
$$;
revoke all on function public.revoke_visual_control_link(text) from public, anon;
grant execute on function public.revoke_visual_control_link(text) to authenticated;

create or replace function public.visual_control_command(p_court_slug text, p_token text, p_action text, p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_court_id uuid;
  v_scope text;
  v_result jsonb;
  v_previous text := current_setting('kpl.visual_court_id', true);
  v_version int := (p_params->>'p_expected_version')::int;
  v_command text := p_params->>'p_command_id';
begin
  select c.id, g.scope into v_court_id, v_scope
  from public.courts c join public.visual_access_grants g on g.court_id = c.id
  where c.slug = p_court_slug and length(p_token) = 64
    and g.token_digest = sha256(convert_to(p_token, 'UTF8'))
    and g.revoked_at is null and g.expires_at > now()
  order by g.created_at desc limit 1;
  if v_court_id is null then raise exception 'Enlace de control inválido o revocado.'; end if;
  if v_scope = 'overlay_read' and p_action <> 'state' then raise exception 'Este permiso es solo de lectura.'; end if;
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
  if v_scope = 'operator_control' and p_action = 'set_match_status' and p_params->>'p_status' = 'finished' then
    update public.visual_access_grants set revoked_at = now()
      where court_id = v_court_id and scope = 'operator_control' and token_digest = sha256(convert_to(p_token, 'UTF8'));
  end if;
  perform set_config('kpl.visual_court_id', coalesce(v_previous, ''), true);
  return v_result;
end;
$$;
revoke all on function public.visual_control_command(text, text, text, jsonb) from public;
grant execute on function public.visual_control_command(text, text, text, jsonb) to anon, authenticated;
