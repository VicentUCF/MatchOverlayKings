begin;

create or replace function pg_temp.assert_true(p_condition boolean, p_label text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_label; end if;
end;
$$;

create or replace function pg_temp.assert_eq_int(p_actual int, p_expected int, p_label text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'Assertion failed: %, expected %, got %', p_label, p_expected, p_actual;
  end if;
end;
$$;

create or replace function pg_temp.use_principal(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user_id, 'role', 'authenticated'
  )::text, true);
end;
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'claim-agent@example.test', 'unused', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'unassigned-agent@example.test', 'unused', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'claim-human@example.test', 'unused', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.production_principals (id, club_id, auth_user_id, kind, display_name)
values
  ('21000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'agent', 'Claim agent'),
  ('21000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'agent', 'Unassigned agent'),
  ('21000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 'human', 'Claim requester');

insert into public.production_event_days (id, club_id, name, event_date, time_zone, status)
values ('31000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Claim tests', current_date, 'Europe/Madrid', 'active');

insert into public.production_events (
  id, event_day_id, club_id, court_id, title, scheduled_start_at, scheduled_end_at
)
select '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', id, 'Assigned', now(), now() + interval '1 hour'
from public.courts where slug = 'pista-1';

insert into public.production_events (
  id, event_day_id, club_id, court_id, title, scheduled_start_at, scheduled_end_at
)
select '41000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', id, 'Unassigned', now(), now() + interval '1 hour'
from public.courts where slug = 'pista-2';

insert into public.production_assignments (club_id, event_id, principal_id, role)
values ('00000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'agent');

insert into public.production_operations (
  id, club_id, event_id, court_id, command_id, kind, payload, after_state,
  requested_by_principal_id, created_at
)
select value.id, '00000000-0000-4000-8000-000000000001', value.event_id,
  c.id, value.command_id, 'reconcile', '{}'::jsonb, '{}'::jsonb,
  '21000000-0000-4000-8000-000000000003', value.created_at
from (values
  ('51000000-0000-4000-8000-000000000001'::uuid, '41000000-0000-4000-8000-000000000001'::uuid, 'eligible-unclaimed', '2026-09-13T10:00:00Z'::timestamptz),
  ('51000000-0000-4000-8000-000000000002'::uuid, '41000000-0000-4000-8000-000000000001'::uuid, 'eligible-renewal', '2026-09-13T10:01:00Z'::timestamptz),
  ('51000000-0000-4000-8000-000000000003'::uuid, '41000000-0000-4000-8000-000000000001'::uuid, 'eligible-expired', '2026-09-13T10:02:00Z'::timestamptz),
  ('51000000-0000-4000-8000-000000000004'::uuid, '41000000-0000-4000-8000-000000000001'::uuid, 'excluded-terminal', '2026-09-13T10:03:00Z'::timestamptz),
  ('51000000-0000-4000-8000-000000000005'::uuid, '41000000-0000-4000-8000-000000000001'::uuid, 'excluded-active-other', '2026-09-13T10:04:00Z'::timestamptz),
  ('51000000-0000-4000-8000-000000000006'::uuid, '41000000-0000-4000-8000-000000000002'::uuid, 'excluded-unassigned', '2026-09-13T10:05:00Z'::timestamptz),
  ('51000000-0000-4000-8000-000000000007'::uuid, '41000000-0000-4000-8000-000000000001'::uuid, 'excluded-failed', '2026-09-13T10:06:00Z'::timestamptz)
) as value(id, event_id, command_id, created_at)
join public.courts c on c.slug = case value.event_id
  when '41000000-0000-4000-8000-000000000001' then 'pista-1' else 'pista-2' end;

insert into public.production_operation_claims (
  operation_id, agent_principal_id, club_id, status, claimed_at, lease_expires_at, completed_at
) values
  ('51000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'claimed', now(), now() + interval '1 minute', null),
  ('51000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'claimed', now() - interval '2 minutes', now() - interval '1 minute', null),
  ('51000000-0000-4000-8000-000000000004', '21000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'completed', now(), now() + interval '1 minute', now()),
  ('51000000-0000-4000-8000-000000000005', '21000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'claimed', now(), now() + interval '1 day', null),
  ('51000000-0000-4000-8000-000000000007', '21000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'failed', now(), now() + interval '1 day', now());

insert into public.production_operations (
  club_id, event_id, court_id, command_id, kind, payload, after_state,
  requested_by_principal_id, created_at
)
select '00000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
  c.id, 'bulk-' || lpad(n::text, 3, '0'), 'reconcile', '{}'::jsonb, '{}'::jsonb,
  '21000000-0000-4000-8000-000000000003', '2026-09-14T10:00:00Z'::timestamptz + n * interval '1 second'
from generate_series(1, 105) n cross join public.courts c where c.slug = 'pista-1';

set local role authenticated;
select pg_temp.use_principal('11000000-0000-4000-8000-000000000001');

select pg_temp.assert_true(
  (select array_agg(command_id order by created_at, id) from public.production_list_claimable_operations_v1(3))
    = array['eligible-unclaimed', 'eligible-renewal', 'eligible-expired'],
  'assigned eligibility and deterministic ordering'
);
select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_list_claimable_operations_v1(1000)), 100,
  'result limit is bounded at one hundred'
);
select pg_temp.assert_true(
  not exists (
    select 1 from public.production_list_claimable_operations_v1(100) row
    where row.command_id in (
      'excluded-terminal', 'excluded-active-other', 'excluded-unassigned', 'excluded-failed'
    )
  ),
  'terminal, active foreign, and unassigned operations are excluded'
);
select pg_temp.assert_true(
  (public.production_claim_operation_v1(
    '51000000-0000-4000-8000-000000000002', 60
  ) ->> 'agent_principal_id')::uuid = '21000000-0000-4000-8000-000000000001',
  'same agent renews through the existing atomic claim RPC'
);
select pg_temp.assert_true(
  (public.production_claim_operation_v1(
    '51000000-0000-4000-8000-000000000003', 60
  ) ->> 'agent_principal_id')::uuid = '21000000-0000-4000-8000-000000000001',
  'expired foreign lease is recovered through the existing atomic claim RPC'
);
select pg_temp.assert_true(
  (select not (to_jsonb(row) ?| array['before_state', 'after_state', 'secret_ref'])
    from public.production_list_claimable_operations_v1(1) row),
  'result exposes no internal state or secret fields'
);

do $$ begin
  perform public.production_list_claimable_operations_v1(0);
  raise exception 'Non-positive limit should fail.';
exception when others then
  if sqlerrm <> 'INVALID_LIMIT' then raise; end if;
end; $$;

do $$ begin
  perform public.production_list_claimable_operations_v1(null);
  raise exception 'Null limit should fail.';
exception when others then
  if sqlerrm <> 'INVALID_LIMIT' then raise; end if;
end; $$;

select pg_temp.use_principal('11000000-0000-4000-8000-000000000002');
select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_list_claimable_operations_v1(100)), 0,
  'unassigned agent sees no operations'
);

reset role;
set local role anon;
do $$ begin
  perform public.production_list_claimable_operations_v1(1);
  raise exception 'Anonymous discovery should fail.';
exception when insufficient_privilege then null;
end; $$;

rollback;
