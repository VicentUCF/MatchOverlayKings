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

create or replace function pg_temp.use_principal(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text,
    true
  );
end;
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'producer@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'agent@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'other-agent@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'device@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'other-device@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'operator@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.production_principals (id, club_id, auth_user_id, kind, display_name)
values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'human', 'Producer'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'agent', 'Pista 1 agent'),
  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'agent', 'Unassigned agent'),
  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'device', 'Pista 1 camera'),
  ('20000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 'device', 'Pista 2 camera');

insert into public.club_users (club_id, user_id, role)
values ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'admin')
on conflict do nothing;

insert into public.club_users (club_id, user_id, role)
values ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000006', 'member')
on conflict do nothing;

select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_principal_roles r
    join public.production_principals p on p.id = r.principal_id
    where p.auth_user_id = '10000000-0000-4000-8000-000000000006'
      and r.role = 'production_admin'),
  0,
  'club member does not become production admin automatically'
);

insert into public.clubs (id, slug, name)
values ('00000000-0000-4000-8000-000000000002', 'sql-production-test', 'SQL Production Test');

insert into public.club_users (club_id, user_id, role)
values ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'admin');

select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_principals where auth_user_id = '10000000-0000-4000-8000-000000000001'),
  2,
  'human identities remain club scoped'
);

insert into public.production_principal_roles (principal_id, club_id, role)
values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'production_admin'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'agent'),
  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'agent'),
  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'device'),
  ('20000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'device')
on conflict do nothing;

insert into public.production_event_days (id, club_id, name, event_date, time_zone, status)
values ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'SQL production test', current_date, 'Europe/Madrid', 'active');

insert into public.production_devices (id, club_id, principal_id, name, kind, secret_ref)
values
  ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004', 'Camera 1', 'camera', 'local://devices/camera-1'),
  ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'Display 2', 'display', 'local://devices/display-2');

select pg_temp.assert_eq_int((select count(*)::int from public.courts), 4, 'all four courts remain seeded');
select pg_temp.assert_eq_int((select count(*)::int from public.courts where production_enabled), 3, 'three courts enabled by default');
select pg_temp.assert_true((select not production_enabled from public.courts where slug = 'pista-4'), 'pista-4 remains disabled capacity');

set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000001');

do $$
declare
  v_event jsonb;
  v_duplicate jsonb;
  v_start timestamptz := now() - interval '10 minutes';
  v_end timestamptz := now() + interval '2 hours';
begin
  v_event := public.production_schedule_event_v1(
    '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'pista-1',
    'Scheduled final',
    v_start,
    v_end,
    0,
    'schedule-pista-1'
  );
  perform pg_temp.assert_eq_int((v_event ->> 'version')::int, 1, 'schedule creates version one');

  v_duplicate := public.production_schedule_event_v1(
    '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'pista-1',
    'Scheduled final',
    v_start,
    v_end,
    0,
    'schedule-pista-1'
  );
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, 1, 'duplicate schedule keeps version');
  perform pg_temp.assert_eq_int(
    (select count(*)::int from public.production_event_commands where command_id = 'schedule-pista-1'),
    1,
    'duplicate schedule audits once'
  );

  begin
    perform public.production_set_event_status_v1(
      '50000000-0000-4000-8000-000000000099',
      'live',
      0,
      'start-unscheduled'
    );
    raise exception 'Unscheduled start should fail.';
  exception when others then
    if sqlerrm <> 'EVENT_NOT_FOUND' then raise; end if;
  end;
end;
$$;

reset role;

insert into public.production_assignments (id, club_id, event_id, principal_id, role)
values
  ('60000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'operator'),
  ('60000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'agent'),
  ('60000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004', 'capture'),
  ('60000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'capture');

insert into public.production_outputs (id, club_id, event_id, court_id, name, kind, transport, secret_ref)
select
  '70000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  id,
  'Program',
  'program',
  'srt',
  'local://outputs/pista-1-program'
from public.courts where slug = 'pista-1';

set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000001');
select pg_temp.assert_eq_int(
  (public.production_set_event_status_v1(
    '50000000-0000-4000-8000-000000000001', 'live', 1, 'start-pista-1'
  ) ->> 'version')::int,
  2,
  'readiness permits live only after output, agent, and capture provisioning'
);
reset role;

insert into public.production_events (
  id, event_day_id, club_id, court_id, title, scheduled_start_at, scheduled_end_at
)
select
  '50000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  id,
  'Unassigned event',
  now() - interval '10 minutes',
  now() + interval '2 hours'
from public.courts where slug = 'pista-2';

insert into public.production_asset_specs (
  id, club_id, event_id, key, version, kind, uri, sha256, media_type, width, height
)
values
  ('80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'assigned/logo', 1, 'image', 'asset://assigned/logo-v1', repeat('a', 64), 'image/png', 100, 100),
  ('80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'assigned/logo', 1, 'image', 'asset://unassigned/logo-v1', repeat('b', 64), 'image/png', 100, 100);

set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000001');

do $$
declare
  v_desired jsonb;
  v_duplicate jsonb;
begin
  v_desired := public.production_set_desired_state_v1(
    '70000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'lifecycle', 'running',
      'profile', jsonb_build_object(
        'courtId', (select id::text from public.courts where slug = 'pista-1'),
        'videoSourceDeviceId', '40000000-0000-4000-8000-000000000001',
        'width', 1920, 'height', 1080, 'framesPerSecond', 30,
        'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
        'audioBitrateKbps', 160, 'overlayEnabled', true
      )
    ),
    0,
    'desired-pista-1',
    'reconcile',
    '{}'::jsonb
  );
  perform pg_temp.assert_eq_int((v_desired ->> 'version')::int, 1, 'desired state starts at version one');

  v_duplicate := public.production_set_desired_state_v1(
    '70000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'lifecycle', 'running',
      'profile', jsonb_build_object(
        'courtId', (select id::text from public.courts where slug = 'pista-1'),
        'videoSourceDeviceId', '40000000-0000-4000-8000-000000000001',
        'width', 1920, 'height', 1080, 'framesPerSecond', 30,
        'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
        'audioBitrateKbps', 160, 'overlayEnabled', true
      )
    ),
    0,
    'desired-pista-1',
    'reconcile',
    '{}'::jsonb
  );
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, 1, 'duplicate desired command keeps version');
  perform pg_temp.assert_eq_int(
    (select count(*)::int from public.production_operations where command_id = 'desired-pista-1'),
    1,
    'desired command creates one immutable operation'
  );

  begin
    perform public.production_set_desired_state_v1(
      '70000000-0000-4000-8000-000000000001',
      jsonb_build_object(
        'lifecycle', 'running',
        'profile', jsonb_build_object(
          'courtId', (select id::text from public.courts where slug = 'pista-1'),
          'videoSourceDeviceId', '40000000-0000-4000-8000-000000000002',
          'width', 1920, 'height', 1080, 'framesPerSecond', 30,
          'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
          'audioBitrateKbps', 160, 'overlayEnabled', true
        )
      ),
      1, 'desired-display-source', 'start', '{}'::jsonb
    );
    raise exception 'Display must not be accepted as video source.';
  exception when others then
    if sqlerrm <> 'INVALID_DESIRED_STATE' then raise; end if;
  end;
end;
$$;

do $$
begin
  perform public.production_set_event_status_v1(
    '50000000-0000-4000-8000-000000000001', 'completed', 2, 'complete-active-output'
  );
  raise exception 'Terminal event transition with running desired output should fail.';
exception when others then
  if sqlerrm <> 'EVENT_HAS_ACTIVE_OUTPUTS' then raise; end if;
end;
$$;

do $$
begin
  update public.production_desired_states set version = 99 where output_id = '70000000-0000-4000-8000-000000000001';
  raise exception 'Direct human update should fail.';
exception when insufficient_privilege then
  null;
end;
$$;

reset role;
set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000002');

select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_asset_specs),
  1,
  'agent reads assets only for assigned events'
);

select pg_temp.assert_eq_int(
  (public.production_report_observed_state_v1(
    '70000000-0000-4000-8000-000000000001',
    1,
    'healthy',
    jsonb_build_object('running', true)
  ) ->> 'sequence')::int,
  1,
  'assigned agent reports observation'
);

select pg_temp.assert_true(
  public.production_get_assigned_secret_refs_v1('50000000-0000-4000-8000-000000000001')
    #>> '{outputs,0,secretRef}' = 'local://outputs/pista-1-program',
  'only assigned agent retrieves local secret references'
);

do $$
begin
  perform public.production_report_observed_state_v1(
    '70000000-0000-4000-8000-000000000001', 1, 'healthy', '{}'::jsonb
  );
  raise exception 'Stale sequence should fail.';
exception when others then
  if sqlerrm <> 'SEQUENCE_CONFLICT' then raise; end if;
end;
$$;

select pg_temp.assert_true(
  (public.production_claim_operation_v1(
    (select id from public.production_operations where command_id = 'desired-pista-1'),
    60
  ) ->> 'agent_principal_id')::uuid = '20000000-0000-4000-8000-000000000002',
  'assigned agent claims operation'
);

select pg_temp.assert_true(
  (public.production_complete_operation_v1(
    (select id from public.production_operations where command_id = 'desired-pista-1'),
    'completed', jsonb_build_object('summary', 'Program reconciled', 'retryable', false)
  ) ->> 'status') = 'completed',
  'owning agent completes an active lease'
);

do $$
begin
  perform public.production_claim_operation_v1(
    (select id from public.production_operations where command_id = 'desired-pista-1'), 60
  );
  raise exception 'Terminal operation claim should not reopen.';
exception when others then
  if sqlerrm <> 'OPERATION_CLAIM_CONFLICT' then raise; end if;
end;
$$;

reset role;

do $$
begin
  update public.production_events
  set court_id = (select id from public.courts where slug = 'pista-2')
  where id = '50000000-0000-4000-8000-000000000001';
  raise exception 'Event court with outputs should be immutable.';
exception when others then
  if sqlerrm <> 'EVENT_COURT_HAS_OUTPUTS' then raise; end if;
end;
$$;

do $$
begin
  update public.production_outputs
  set event_id = '50000000-0000-4000-8000-000000000002',
      court_id = (select id from public.courts where slug = 'pista-2')
  where id = '70000000-0000-4000-8000-000000000001';
  raise exception 'Output event identity should be immutable.';
exception when others then
  if sqlerrm <> 'OUTPUT_EVENT_IDENTITY_IMMUTABLE' then raise; end if;
end;
$$;

set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000003');

do $$
begin
  perform public.production_report_observed_state_v1(
    '70000000-0000-4000-8000-000000000001',
    2,
    'healthy',
    '{}'::jsonb
  );
  raise exception 'Unassigned agent report should fail.';
exception when others then
  if sqlerrm <> 'FORBIDDEN' then raise; end if;
end;
$$;

do $$
begin
  perform public.production_complete_operation_v1(
    (select id from public.production_operations where command_id = 'desired-pista-1'),
    'failed', jsonb_build_object('summary', 'Not owner', 'retryable', false)
  );
  raise exception 'Non-owner completion should fail.';
exception when others then
  if sqlerrm <> 'OPERATION_COMPLETION_CONFLICT' then raise; end if;
end;
$$;

reset role;
set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000004');

select pg_temp.assert_eq_int((select count(*)::int from public.production_devices), 1, 'device reads only itself');
select pg_temp.assert_eq_int((select count(*)::int from public.production_outputs), 0, 'device cannot read outputs');
do $$
declare
  v_device jsonb;
begin
  v_device := public.production_device_heartbeat_v1(jsonb_build_object('batteryPercent', 80));
  perform pg_temp.assert_true(v_device ->> 'last_heartbeat_at' is not null, 'device updates its own heartbeat');
  perform pg_temp.assert_eq_int((v_device ->> 'version')::int, 1, 'heartbeat preserves configuration version');
end;
$$;

do $$
begin
  perform public.production_report_observed_state_v1(
    '70000000-0000-4000-8000-000000000001',
    2,
    'healthy',
    '{}'::jsonb
  );
  raise exception 'Device must not report agent observations.';
exception when others then
  if sqlerrm <> 'PRINCIPAL_KIND_REQUIRED:agent' then raise; end if;
end;
$$;

reset role;
set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000001');

select pg_temp.assert_eq_int(
  (public.production_set_human_role_v1(
    (select id from public.production_principals where auth_user_id = '10000000-0000-4000-8000-000000000006' and club_id = '00000000-0000-4000-8000-000000000001'),
    'operator', true, 1, 'grant-operator'
  ) ->> 'version')::int,
  2,
  'production admin grants operator role'
);

reset role;
set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000006');

select pg_temp.assert_eq_int(
  (public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000006',
    'Operator managed day', current_date, 'Europe/Madrid', 'draft', 0, 'operator-day'
  ) ->> 'version')::int,
  1,
  'operator performs intended production management'
);

do $$
begin
  perform public.production_set_human_role_v1(
    (select id from public.production_principals where auth_user_id = '10000000-0000-4000-8000-000000000006' and club_id = '00000000-0000-4000-8000-000000000001'),
    'viewer', true, 2, 'operator-escalation'
  );
  raise exception 'Operator role administration should fail.';
exception when others then
  if sqlerrm <> 'FORBIDDEN' then raise; end if;
end;
$$;

reset role;
set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000001');

select pg_temp.assert_eq_int(
  (public.production_set_human_role_v1(
    (select id from public.production_principals where auth_user_id = '10000000-0000-4000-8000-000000000006' and club_id = '00000000-0000-4000-8000-000000000001'),
    'operator', false, 2, 'revoke-operator'
  ) ->> 'version')::int,
  3,
  'production admin revokes operator role'
);

select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_principal_roles r
    join public.production_principals p on p.id = r.principal_id
    where p.auth_user_id = '10000000-0000-4000-8000-000000000006' and r.role = 'operator'),
  0,
  'revoked role is absent'
);

reset role;
set local role authenticated;
select pg_temp.use_principal('10000000-0000-4000-8000-000000000001');

do $$
begin
  perform public.production_set_event_status_v1(
    '50000000-0000-4000-8000-000000000002', 'ready', 1, 'unready-event'
  );
  raise exception 'Event without program output should not become ready.';
exception when others then
  if sqlerrm <> 'PROGRAM_OUTPUT_REQUIRED' then raise; end if;
end;
$$;

do $$
declare
  v_event jsonb;
begin
  v_event := public.production_schedule_event_v1(
    '50000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000001',
    'pista-4',
    'Disabled capacity',
    now() - interval '10 minutes',
    now() + interval '2 hours',
    0,
    'schedule-pista-4'
  );

  begin
    perform public.production_set_event_status_v1(
      '50000000-0000-4000-8000-000000000004',
      'live',
      (v_event ->> 'version')::int,
      'start-pista-4'
    );
    raise exception 'Disabled court start should fail.';
  exception when others then
    if sqlerrm <> 'COURT_DISABLED' then raise; end if;
  end;
end;
$$;

rollback;
