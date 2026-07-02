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

update public.score_states
set
  status = 'pre_match',
  state = jsonb_set(state, '{status}', '"pre_match"'::jsonb, false)
where court_slug = 'pista-1';

set local role anon;

select pg_temp.assert_eq_int(
  (select count(*)::int from public.score_states where court_slug = 'pista-1'),
  0,
  'anon cannot read non-live score_states'
);

do $$
begin
  perform public.add_point('pista-1', 1, 'sql-anon-add-point', 'home');
  raise exception 'Anon mutation should have failed.';
exception
  when insufficient_privilege then
    null;
  when others then
    if sqlerrm <> 'AUTH_REQUIRED' then
      raise;
    end if;
end;
$$;

reset role;
set local role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009999', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000009999","role":"authenticated"}',
  true
);

do $$
declare
  v_state jsonb;
  v_duplicate jsonb;
  v_version int;
begin
  select version into v_version
  from public.score_states
  where court_slug = 'pista-1';

  v_state := public.new_match(
    'pista-1',
    v_version,
    'sql-new-match',
    jsonb_build_object(
      'title', 'SQL Test',
      'courtName', 'Pista 1',
      'homeTeamId', 'kings-of-favar',
      'awayTeamId', 'red-lions',
      'lineups', public.kpl_empty_lineups(),
      'servingSide', 'home'
    )
  );
  perform pg_temp.assert_eq_text(v_state ->> 'status', 'pre_match', 'new_match returns to setup');
  perform pg_temp.assert_eq_int(jsonb_array_length(v_state -> 'history'), 1, 'new_match resets history');

  v_state := public.set_match_status('pista-1', (v_state ->> 'version')::int, 'sql-live', 'live');
  perform pg_temp.assert_eq_text(v_state ->> 'status', 'live', 'set_match_status live');

  v_state := public.add_point('pista-1', (v_state ->> 'version')::int, 'sql-home-15', 'home');
  perform pg_temp.assert_eq_int((v_state #>> '{currentGame,homePoints}')::int, 1, 'home point increments');

  v_state := public.manual_patch(
    'pista-1',
    (v_state ->> 'version')::int,
    'sql-golden-setup',
    jsonb_build_object(
      'status', 'live',
      'sets', jsonb_build_array(jsonb_build_object(
        'homeGames', 0,
        'awayGames', 0,
        'status', 'active',
        'winner', null,
        'tieBreak', null
      )),
      'currentGame', jsonb_build_object('homePoints', 3, 'awayPoints', 3, 'isTieBreak', false),
      'winner', null
    )
  );
  v_state := public.add_point('pista-1', (v_state ->> 'version')::int, 'sql-golden-home', 'home');
  perform pg_temp.assert_eq_int((v_state #>> '{sets,0,homeGames}')::int, 1, 'golden point closes game');
  perform pg_temp.assert_eq_int((v_state #>> '{currentGame,homePoints}')::int, 0, 'golden point resets game');

  v_state := public.manual_patch(
    'pista-1',
    (v_state ->> 'version')::int,
    'sql-tiebreak-setup',
    jsonb_build_object(
      'status', 'live',
      'sets', jsonb_build_array(jsonb_build_object(
        'homeGames', 6,
        'awayGames', 6,
        'status', 'active',
        'winner', null,
        'tieBreak', null
      )),
      'currentGame', jsonb_build_object('homePoints', 6, 'awayPoints', 6, 'isTieBreak', true),
      'winner', null
    )
  );
  v_state := public.add_point('pista-1', (v_state ->> 'version')::int, 'sql-tiebreak-7', 'home');
  perform pg_temp.assert_eq_text(v_state #>> '{sets,0,status}', 'active', 'tie-break needs win by two');
  v_state := public.add_point('pista-1', (v_state ->> 'version')::int, 'sql-tiebreak-8', 'home');
  perform pg_temp.assert_eq_text(v_state #>> '{sets,0,status}', 'complete', 'tie-break closes set');
  perform pg_temp.assert_eq_text(v_state #>> '{sets,0,tieBreak,winner}', 'home', 'tie-break winner stored');

  v_state := public.manual_patch(
    'pista-1',
    (v_state ->> 'version')::int,
    'sql-match-point-setup',
    jsonb_build_object(
      'status', 'live',
      'sets', jsonb_build_array(
        jsonb_build_object(
          'homeGames', 6,
          'awayGames', 0,
          'status', 'complete',
          'winner', 'home',
          'tieBreak', null
        ),
        jsonb_build_object(
          'homeGames', 5,
          'awayGames', 0,
          'status', 'active',
          'winner', null,
          'tieBreak', null
        )
      ),
      'currentGame', jsonb_build_object('homePoints', 3, 'awayPoints', 0, 'isTieBreak', false),
      'winner', null
    )
  );
  v_state := public.add_point('pista-1', (v_state ->> 'version')::int, 'sql-match-winner', 'home');
  perform pg_temp.assert_eq_text(v_state ->> 'status', 'finished', 'second set closes match');
  perform pg_temp.assert_eq_text(v_state ->> 'winner', 'home', 'match winner stored');

  v_state := public.undo_last('pista-1', (v_state ->> 'version')::int, 'sql-undo');
  perform pg_temp.assert_eq_text(v_state ->> 'status', 'live', 'undo restores previous score snapshot');
  perform pg_temp.assert_true(v_state ->> 'winner' is null, 'undo clears winner from previous snapshot');

  v_state := public.reset_match('pista-1', (v_state ->> 'version')::int, 'sql-reset');
  perform pg_temp.assert_eq_text(v_state ->> 'status', 'pre_match', 'reset returns to setup');

  v_state := public.add_point('pista-1', (v_state ->> 'version')::int, 'sql-idempotent', 'home');
  v_duplicate := public.add_point('pista-1', ((v_state ->> 'version')::int - 1), 'sql-idempotent', 'home');
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, (v_state ->> 'version')::int, 'duplicate command keeps version');
  perform pg_temp.assert_eq_int((v_duplicate #>> '{currentGame,homePoints}')::int, 1, 'duplicate command does not score twice');

  v_state := public.use_match_card('pista-1', (v_state ->> 'version')::int, 'sql-card-home', 'home', '2vs1', '2VS1');
  perform pg_temp.assert_eq_text(v_state #>> '{cards,home,cardId}', '2vs1', 'card use stored on side');
  perform pg_temp.assert_eq_text(v_state #>> '{cards,announcement,cardName}', '2VS1', 'card announcement stored');

  begin
    perform public.use_match_card('pista-1', (v_state ->> 'version')::int, 'sql-card-home-second', 'home', 'comodin', 'Comodin');
    raise exception 'Second card use should have failed.';
  exception
    when others then
      if sqlerrm <> 'Ese equipo ya ha utilizado su carta.' then
        raise;
      end if;
  end;

  v_state := public.reset_match('pista-1', (v_state ->> 'version')::int, 'sql-reset-after-card');
  perform pg_temp.assert_true(v_state #> '{cards,home}' = 'null'::jsonb, 'reset clears home card');

  begin
    perform public.add_point('pista-1', ((v_state ->> 'version')::int - 1), 'sql-version-conflict', 'home');
    raise exception 'Version conflict should have failed.';
  exception
    when others then
      if sqlerrm not like 'VERSION_CONFLICT:%' then
        raise;
      end if;
  end;
end;
$$;

rollback;
