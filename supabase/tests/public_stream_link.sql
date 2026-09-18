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
  '00000000-0000-4000-8000-000000009998',
  'authenticated',
  'authenticated',
  'kpl-stream-test@example.com',
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
  '00000000-0000-4000-8000-000000009998',
  'admin'
)
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009998', true);

select public.publish_court_stream('pista-2', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
select pg_temp.assert_eq_text(
  (select youtube_watch_url from public.score_states where court_slug = 'pista-2'),
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'the emission runtime publishes the watch link'
);

-- Publishing is not a scoring command: the match state and its version stay untouched.
select pg_temp.assert_true(
  (select version from public.score_states where court_slug = 'pista-2') = 1,
  'publishing does not bump the match version'
);

do $$
begin
  begin
    perform public.publish_court_stream('pista-2', 'https://example.com/pista-2');
    raise exception 'TEST: arbitrary link accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.publish_court_stream('pista-inexistente', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    raise exception 'TEST: unknown court accepted';
  exception when others then
    if sqlerrm not like 'No existe el marcador%' then raise; end if;
  end;
end;
$$;

-- A stopped emission clears the link so the home never points at a dead broadcast.
select public.publish_court_stream('pista-2', null);
select pg_temp.assert_true(
  (select youtube_watch_url is null from public.score_states where court_slug = 'pista-2'),
  'stopping the emission clears the watch link'
);

select public.publish_court_stream('pista-2', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
select public.set_match_status('pista-2', (select version from public.score_states where court_slug = 'pista-2'),
  'stream-live', 'live');

set local role anon;
select set_config('request.jwt.claim.sub', '', true);

select pg_temp.assert_eq_text(
  (select youtube_watch_url from public.score_states where court_slug = 'pista-2'),
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'the public home reads the link of a live court'
);
select pg_temp.assert_true(
  not exists (select 1 from public.score_states where court_slug = 'pista-3'),
  'courts that are not live stay hidden from the public'
);

do $$
begin
  begin
    perform public.publish_court_stream('pista-2', 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
    raise exception 'TEST: anonymous publication accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
