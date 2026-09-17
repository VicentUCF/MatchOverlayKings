begin;

create or replace function pg_temp.assert_true(p_condition boolean, p_label text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_label; end if;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated;

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

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.use_principal(uuid) to anon, authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'snapshot-agent@example.test', 'unused', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'inactive-assignment@example.test', 'unused', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'snapshot-human@example.test', 'unused', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'inactive-agent@example.test', 'unused', now(), '{}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.production_principals (
  id, club_id, auth_user_id, kind, display_name, active
) values
  ('22000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 'agent', 'Snapshot agent', true),
  ('22000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000002', 'agent', 'Inactive assignment', true),
  ('22000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000003', 'human', 'Snapshot human', true),
  ('22000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000004', 'agent', 'Inactive agent', false);

insert into public.production_event_days (id, club_id, name, event_date, time_zone, status)
values ('32000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Snapshot tests', current_date, 'Europe/Madrid', 'active');

insert into public.production_events (
  id, event_day_id, club_id, court_id, title, scheduled_start_at, scheduled_end_at
)
select '42000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', id, 'Snapshot event', now(), now() + interval '1 hour'
from public.courts where slug = 'pista-1';

insert into public.production_assignments (club_id, event_id, principal_id, role, active)
values
  ('00000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'agent', true),
  ('00000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002', 'agent', false);

insert into public.production_outputs (
  id, club_id, event_id, court_id, name, kind, transport, secret_ref
)
select output.id, '00000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001', court.id, output.name, 'program', 'local', output.secret_ref
from (values
  ('72000000-0000-4000-8000-000000000001'::uuid, 'With desired', null::text),
  ('72000000-0000-4000-8000-000000000002'::uuid, 'Without desired', 'local://hidden/output')
) as output(id, name, secret_ref)
cross join public.courts court where court.slug = 'pista-1';

insert into public.production_desired_states (
  output_id, club_id, event_id, version, state, updated_by_principal_id, command_id
) select
  '72000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001', 1,
  jsonb_build_object('lifecycle', 'preflight', 'profile', jsonb_build_object(
    'courtId', court.id,
    'videoSourceDeviceId', '62000000-0000-4000-8000-000000000001',
    'width', 1920, 'height', 1080, 'framesPerSecond', 50,
    'videoBitrateKbps', 8000, 'audioSourceDeviceId', null,
    'audioBitrateKbps', 192, 'overlayEnabled', true
  )), '22000000-0000-4000-8000-000000000003', 'snapshot-desired-1'
from public.courts court
where court.slug = 'pista-1';

insert into public.production_observed_states (
  output_id, agent_principal_id, club_id, event_id, sequence, health, state
) values
  ('72000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 7, 'healthy', '{}'),
  ('72000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 99, 'failed', '{}');

set local role authenticated;
select pg_temp.use_principal('12000000-0000-4000-8000-000000000001');
select pg_temp.assert_true(
  jsonb_array_length(public.production_get_assigned_output_snapshots_v1()) = 1,
  'outputs without desired state are omitted'
);
select pg_temp.assert_true(
  public.production_get_assigned_output_snapshots_v1() #>> '{0,observed,agent_principal_id}' = '22000000-0000-4000-8000-000000000001',
  'only the calling agent observed row is nested'
);
select pg_temp.assert_true(
  not (public.production_get_assigned_output_snapshots_v1()::text like '%secret_ref%'),
  'snapshot RPC exposes no secret ref key'
);

select pg_temp.use_principal('12000000-0000-4000-8000-000000000002');
select pg_temp.assert_true(
  public.production_get_assigned_output_snapshots_v1() = '[]'::jsonb,
  'inactive assignment exposes no snapshots'
);

select pg_temp.use_principal('12000000-0000-4000-8000-000000000003');
do $$ begin
  perform public.production_get_assigned_output_snapshots_v1();
  raise exception 'Human principal should fail.';
exception when others then
  if sqlerrm <> 'PRINCIPAL_KIND_REQUIRED:agent' then raise; end if;
end; $$;

select pg_temp.use_principal('12000000-0000-4000-8000-000000000004');
do $$ begin
  perform public.production_get_assigned_output_snapshots_v1();
  raise exception 'Inactive agent principal should fail.';
exception when others then
  if sqlerrm <> 'PRINCIPAL_KIND_REQUIRED:agent' then raise; end if;
end; $$;

reset role;
select pg_temp.assert_true(
  p.prosecdef
    and p.proconfig @> array['search_path=pg_catalog, public']
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
    and not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ),
  'snapshot function has fixed search path, definer security, and narrow ACL'
)
from pg_proc p
where p.oid = 'public.production_get_assigned_output_snapshots_v1()'::regprocedure;

rollback;
