begin;

create or replace function pg_temp.assert_true(p_condition boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Assertion failed: %', p_label;
  end if;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated;

create or replace function pg_temp.assert_eq_int(p_actual int, p_expected int, p_label text)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'Assertion failed: %, expected %, got %', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_eq_int(int, int, text) to anon, authenticated;

create or replace function pg_temp.assert_eq_text(p_actual text, p_expected text, p_label text)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'Assertion failed: %, expected %, got %', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_eq_text(text, text, text) to anon, authenticated;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000009999',
  'authenticated',
  'authenticated',
  'kpl-rpc-test@example.com',
  'not-used',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.club_users (club_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000009999',
  'admin'
)
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009999', true);

-- Use a different seeded pairing first, to prove configuration updates the actual overlay state.
select public.update_match_meta('pista-1', (select version from public.score_states where court_slug = 'pista-1'),
  'binding-before', '{"homeTeamId":"red-lions","awayTeamId":"kings-of-favar"}'::jsonb);

create function pg_temp.binding_input() returns jsonb language sql as $$
  select '{"courtSlug":"pista-1","homeTeam":"Kings of Favar","awayTeam":"Red Lions","matchdayNumber":1,"seasonLabel":"T2"}'::jsonb;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.binding_input() to anon, authenticated;
select public.configure_pilot_match(pg_temp.binding_input(), true);
select pg_temp.assert_eq_text((select state->>'homeTeamId' from public.score_states where court_slug = 'pista-1'), 'kings-of-favar', 'admin assigns home team');
select pg_temp.assert_eq_text((select state->>'awayTeamId' from public.score_states where court_slug = 'pista-1'), 'red-lions', 'admin assigns away team');
select pg_temp.assert_true((select (state->>'productionConfigured')::boolean from public.score_states where court_slug = 'pista-1'), 'control sees identity lock');
select public.configure_pilot_match(pg_temp.binding_input(), false);

reset role;
update public.courts set production_enabled = false where slug = 'pista-1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009999', true);
do $$
begin
  begin
    perform public.configure_pilot_match(pg_temp.binding_input(), false);
    raise exception 'Assertion failed: disabled court must reject emission binding';
  exception when others then
    if sqlerrm not like '%producción de esta pista está desactivada%' then raise; end if;
  end;
end;
$$;
reset role;
update public.courts set production_enabled = true where slug = 'pista-1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009999', true);

do $$
begin
  begin
    perform public.configure_pilot_match(pg_temp.binding_input() || '{"homeTeam":"Red Lions"}'::jsonb, false);
    raise exception 'TEST: mismatch accepted';
  exception when others then
    if sqlerrm not like 'La emisión no coincide%' then raise; end if;
  end;
  begin
    perform public.update_match_meta('pista-1', (select version from public.score_states where court_slug = 'pista-1'),
      'binding-forbidden-meta', '{"homeTeamId":"red-lions","awayTeamId":"kings-of-favar"}'::jsonb);
    raise exception 'TEST: operator replaced match';
  exception when others then
    if sqlerrm not like 'El partido está fijado%' then raise; end if;
  end;
  begin
    perform public.new_match('pista-1', (select version from public.score_states where court_slug = 'pista-1'),
      'binding-forbidden-new', '{"homeTeamId":"red-lions","awayTeamId":"kings-of-favar"}'::jsonb);
    raise exception 'TEST: new_match replaced identity';
  exception when others then
    if sqlerrm not like 'El partido está fijado%' then raise; end if;
  end;
  begin
    perform public.configure_pilot_match(pg_temp.binding_input() || '{"awayTeam":"Kings of Favar"}'::jsonb, true);
    raise exception 'TEST: identical teams accepted';
  exception when others then
    if sqlerrm not like 'Selecciona dos equipos%' then raise; end if;
  end;
end;
$$;
-- Normal score operations and a same-identity reset remain available.
select public.add_point('pista-1', (select version from public.score_states where court_slug = 'pista-1'), 'binding-point', 'home');
select public.new_match('pista-1', (select version from public.score_states where court_slug = 'pista-1'), 'binding-reset', '{}'::jsonb);
select pg_temp.assert_true((select (state->>'productionConfigured')::boolean from public.score_states where court_slug = 'pista-1'), 'reset preserves identity lock');
-- A new admin assignment works when no match is live.
select public.configure_pilot_match(pg_temp.binding_input() || '{"homeTeam":"Red Lions","awayTeam":"Kings of Favar"}'::jsonb, true);
select pg_temp.assert_eq_text((select state->>'homeTeamId' from public.score_states where court_slug = 'pista-1'), 'red-lions', 'admin can schedule next match');
select public.set_match_status('pista-1', (select version from public.score_states where court_slug = 'pista-1'), 'binding-live', 'live');
do $$
begin
  begin
    perform public.configure_pilot_match(pg_temp.binding_input(), true);
    raise exception 'TEST: replaced live match';
  exception when others then
    if sqlerrm not like 'Finaliza el partido%' then raise; end if;
  end;
end;
$$;
set local role anon;
do $$
begin
  begin
    perform public.configure_pilot_match(pg_temp.binding_input(), true);
    raise exception 'TEST: anonymous configuration accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
