begin;

insert into auth.users(id) values ('00000000-0000-4000-8000-000000009997');
insert into public.club_users(club_id, user_id)
select club_id, '00000000-0000-4000-8000-000000009997' from public.courts where slug = 'pista-1';
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009997', true);
set local role authenticated;

select set_config('test.overlay_token', public.configure_pilot_access('pista-1', 'recording', 'T2', 1)->>'token', true);
select set_config('test.operator_token', public.create_visual_control_link('pista-1', 'T2', 1)->>'token', true);
select public.set_match_status('pista-1', (select version from public.score_states where court_slug = 'pista-1'), 'private-live', 'live');

reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role anon;

do $$
declare v_state jsonb;
begin
  if exists (select 1 from public.score_states where court_slug = 'pista-1') then
    raise exception 'Internal recording leaked through public RLS';
  end if;
  v_state := public.visual_control_command('pista-1', current_setting('test.overlay_token'), 'state');
  if v_state is null then raise exception 'Overlay read grant cannot read internal state'; end if;
  begin
    perform public.visual_control_command('pista-1', current_setting('test.overlay_token'), 'add_point', '{}'::jsonb);
    raise exception 'Read-only overlay grant accepted a write';
  exception when others then
    if sqlerrm <> 'Este permiso es solo de lectura.' then raise; end if;
  end;
end;
$$;

reset role;
set local role postgres;
update public.visual_access_grants set expires_at = now() - interval '1 second'
where token_digest = sha256(convert_to(current_setting('test.operator_token'), 'UTF8'));
set local role anon;
do $$
begin
  begin
    perform public.visual_control_command('pista-1', current_setting('test.operator_token'), 'state');
    raise exception 'Expired operator token accepted';
  exception when others then
    if sqlerrm <> 'Enlace de control inválido o revocado.' then raise; end if;
  end;
end;
$$;

rollback;
