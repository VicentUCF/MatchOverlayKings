begin;

insert into auth.users(id) values ('00000000-0000-4000-8000-000000009998');
insert into public.club_users(club_id, user_id)
select club_id, '00000000-0000-4000-8000-000000009998' from public.courts where slug = 'pista-1';
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009998', true);
set local role authenticated;
select set_config('test.visual_token', public.create_visual_control_link('pista-1'), true);
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role anon;

do $$
declare
  v_token text := current_setting('test.visual_token');
  v_state jsonb;
  v_next jsonb;
begin
  v_state := public.visual_control_command('pista-1', v_token, 'state');
  if v_state is null then raise exception 'Token must read pre-match state'; end if;
  v_next := public.visual_control_command('pista-1', v_token, 'set_match_status', jsonb_build_object(
    'p_expected_version', v_state->'version', 'p_command_id', 'token-start', 'p_status', 'live'));
  v_state := public.visual_control_command('pista-1', v_token, 'add_point', jsonb_build_object(
    'p_expected_version', v_next->'version', 'p_command_id', 'token-point', 'p_side', 'home', 'p_court_slug', 'pista-2'));
  if (v_state->>'version')::int <> (v_next->>'version')::int + 1 then raise exception 'Point failed'; end if;
  v_next := public.visual_control_command('pista-1', v_token, 'add_point', jsonb_build_object(
    'p_expected_version', v_next->'version', 'p_command_id', 'token-point', 'p_side', 'home'));
  if v_state <> v_next then raise exception 'Idempotence failed'; end if;
  v_state := public.visual_control_command('pista-1', v_token, 'trigger_sponsor_fullscreen', jsonb_build_object(
    'p_expected_version', v_next->'version', 'p_command_id', 'token-sponsor', 'p_sponsor_ids', '[]'::jsonb, 'p_duration_seconds', 8));
  begin
    perform public.visual_control_command('pista-2', v_token, 'state');
    raise exception 'Cross-court access accepted';
  exception when others then
    if sqlerrm <> 'Enlace de control inválido o revocado.' then raise; end if;
  end;
  begin
    perform public.visual_control_command('pista-1', repeat('0', 64), 'state');
    raise exception 'Invalid token accepted';
  exception when others then
    if sqlerrm <> 'Enlace de control inválido o revocado.' then raise; end if;
  end;
  begin
    perform public.visual_control_command('pista-1', v_token, 'create_visual_control_link');
    raise exception 'Arbitrary command accepted';
  exception when others then
    if sqlerrm <> 'Comando de control no permitido.' then raise; end if;
  end;
  if nullif(current_setting('kpl.visual_court_id', true), '') is not null then
    raise exception 'Court authorization leaked outside wrapper';
  end if;
  begin
    perform public.add_point('pista-1', (v_state->>'version')::int, 'token-no-leak', 'home');
    raise exception 'Authorization leaked outside wrapper';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_visual_control_link('pista-1');
    raise exception 'Anonymous link creation accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009998', true);
set local role authenticated;
select set_config('test.visual_new_token', public.create_visual_control_link('pista-1'), true);
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role anon;
do $$
begin
  begin
    perform public.visual_control_command('pista-1', current_setting('test.visual_token'), 'state');
    raise exception 'Revoked token accepted';
  exception when others then
    if sqlerrm <> 'Enlace de control inválido o revocado.' then raise; end if;
  end;
  if public.visual_control_command('pista-1', current_setting('test.visual_new_token'), 'state') is null then
    raise exception 'Replacement token failed';
  end if;
end;
$$;
rollback;
