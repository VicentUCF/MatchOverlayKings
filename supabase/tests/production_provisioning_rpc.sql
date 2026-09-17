begin;

create or replace function pg_temp.assert_true(p_condition boolean, p_label text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'Assertion failed: %', p_label; end if;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated;

create or replace function pg_temp.assert_eq_int(p_actual int, p_expected int, p_label text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'Assertion failed: %, expected %, got %', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_eq_int(int, int, text) to anon, authenticated;

create or replace function pg_temp.use_principal(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.use_principal(uuid) to anon, authenticated;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'provisioner@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'provisioned-agent@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'provisioned-device@example.test', 'not-used', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.club_users (club_id, user_id, role)
values ('00000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'admin')
on conflict do nothing;

set local role authenticated;
select pg_temp.use_principal('11000000-0000-4000-8000-000000000001');

do $$
declare
  v_row jsonb;
  v_duplicate jsonb;
begin
  v_row := public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'Provisioning day', current_date, 'Europe/Madrid', 'active', 0, 'provision-day'
  );
  perform pg_temp.assert_eq_int((v_row ->> 'version')::int, 1, 'human creates event day');
  v_duplicate := public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'Provisioning day', current_date, 'Europe/Madrid', 'active', 0, 'provision-day'
  );
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, 1, 'event day duplicate is idempotent');
  begin
    perform public.production_upsert_event_day_v1(
      '00000000-0000-4000-8000-000000000001',
      '31000000-0000-4000-8000-000000000001',
      'Stale', current_date, 'Europe/Madrid', 'active', 0, 'provision-day-stale'
    );
    raise exception 'Stale event day should fail.';
  exception when others then
    if sqlerrm <> 'VERSION_CONFLICT:1' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_original jsonb;
begin
  perform public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'Provisioning day updated', current_date, 'Europe/Madrid', 'active', 1, 'provision-day-update'
  );
  v_original := public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'Provisioning day', current_date, 'Europe/Madrid', 'active', 0, 'provision-day'
  );
  perform pg_temp.assert_eq_int((v_original ->> 'version')::int, 1, 'delayed duplicate returns exact original result');

  begin
    perform public.production_upsert_event_day_v1(
      '00000000-0000-4000-8000-000000000001',
      '31000000-0000-4000-8000-000000000001',
      'Changed payload', current_date, 'Europe/Madrid', 'active', 0, 'provision-day'
    );
    raise exception 'Changed duplicate payload should fail.';
  exception when others then
    if sqlerrm <> 'COMMAND_ID_REUSED' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_agent jsonb;
  v_duplicate jsonb;
begin
  v_agent := public.production_upsert_machine_principal_v1(
    '21000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000002',
    'agent', 'Provisioned agent', true, 0, 'provision-agent'
  );
  perform pg_temp.assert_eq_int((v_agent ->> 'version')::int, 1, 'human creates agent principal');
  v_duplicate := public.production_upsert_machine_principal_v1(
    '21000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000002',
    'agent', 'Provisioned agent', true, 0, 'provision-agent'
  );
  perform pg_temp.assert_true((v_duplicate ->> 'active')::boolean, 'principal duplicate preserves result');
  begin
    perform public.production_upsert_machine_principal_v1(
      '21000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000002',
      'agent', 'Stale', true, 0, 'provision-agent-stale'
    );
    raise exception 'Stale principal should fail.';
  exception when others then
    if sqlerrm <> 'VERSION_CONFLICT:1' then raise; end if;
  end;

  perform public.production_upsert_machine_principal_v1(
    '21000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000003',
    'device', 'Provisioned camera', true, 0, 'provision-device-principal'
  );
end;
$$;

select public.production_schedule_event_v1(
  '51000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  'pista-1', 'Provisioned event', now() - interval '5 minutes', now() + interval '2 hours',
  0, 'provision-event'
);

do $$
declare
  v_row jsonb;
  v_duplicate jsonb;
begin
  v_row := public.production_upsert_device_v1(
    '41000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000003',
    'Camera 1', 'camera', 'local://devices/camera-1', true, 0, 'provision-device'
  );
  perform pg_temp.assert_eq_int((v_row ->> 'version')::int, 1, 'human creates device');
  perform pg_temp.assert_true(not (v_row ? 'secret_ref'), 'device provisioning result is redacted');
  v_duplicate := public.production_upsert_device_v1(
    '41000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000003',
    'Camera 1', 'camera', 'local://devices/camera-1', true, 0, 'provision-device'
  );
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, 1, 'device duplicate is idempotent');
  begin
    perform public.production_upsert_device_v1(
      '41000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000003',
      'Stale', 'camera', 'local://devices/camera-1', true, 0, 'provision-device-stale'
    );
    raise exception 'Stale device should fail.';
  exception when others then
    if sqlerrm <> 'VERSION_CONFLICT:1' then raise; end if;
  end;
  begin
    perform public.production_upsert_device_v1(
      '41000000-0000-4000-8000-000000000009',
      '21000000-0000-4000-8000-000000000003',
      'Bad secret', 'camera', 'literal-password', true, 0, 'provision-device-secret'
    );
    raise exception 'Literal device secret should fail.';
  exception when others then
    if sqlerrm <> 'LOCAL_SECRET_REF_REQUIRED' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_row jsonb;
  v_duplicate jsonb;
begin
  v_row := public.production_upsert_assignment_v1(
    '61000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000002',
    'agent', true, 0, 'assign-agent'
  );
  perform pg_temp.assert_eq_int((v_row ->> 'version')::int, 1, 'human assigns agent');
  v_duplicate := public.production_upsert_assignment_v1(
    '61000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000002',
    'agent', true, 0, 'assign-agent'
  );
  perform pg_temp.assert_true((v_duplicate ->> 'active')::boolean, 'assignment duplicate preserves result');
  begin
    perform public.production_upsert_assignment_v1(
      '61000000-0000-4000-8000-000000000001',
      '51000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000002',
      'agent', true, 0, 'assign-agent-stale'
    );
    raise exception 'Stale assignment should fail.';
  exception when others then
    if sqlerrm <> 'VERSION_CONFLICT:1' then raise; end if;
  end;

  perform public.production_upsert_assignment_v1(
    '61000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000003',
    'capture', true, 0, 'assign-device'
  );
end;
$$;

do $$
declare
  v_row jsonb;
  v_duplicate jsonb;
begin
  v_row := public.production_upsert_output_v1(
    '71000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    'Program', 'program', 'srt', 'local://outputs/program', true, 0, 'provision-output'
  );
  perform pg_temp.assert_eq_int((v_row ->> 'version')::int, 1, 'human creates output');
  perform pg_temp.assert_true(not (v_row ? 'secret_ref'), 'output provisioning result is redacted');
  v_duplicate := public.production_upsert_output_v1(
    '71000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    'Program', 'program', 'srt', 'local://outputs/program', true, 0, 'provision-output'
  );
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, 1, 'output duplicate is idempotent');
  begin
    perform public.production_upsert_output_v1(
      '71000000-0000-4000-8000-000000000001',
      '51000000-0000-4000-8000-000000000001',
      'Stale', 'program', 'srt', 'local://outputs/program', true, 0, 'provision-output-stale'
    );
    raise exception 'Stale output should fail.';
  exception when others then
    if sqlerrm <> 'VERSION_CONFLICT:1' then raise; end if;
  end;
  begin
    perform public.production_upsert_output_v1(
      '71000000-0000-4000-8000-000000000009',
      '51000000-0000-4000-8000-000000000001',
      'Bad secret', 'program', 'srt', 'literal-stream-key', true, 0, 'provision-output-secret'
    );
    raise exception 'Literal output secret should fail.';
  exception when others then
    if sqlerrm <> 'LOCAL_SECRET_REF_REQUIRED' then raise; end if;
  end;
end;
$$;

do $$
begin
  perform public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'lifecycle', null,
      'profile', jsonb_build_object(
        'courtId', (select id::text from public.courts where slug = 'pista-1'),
        'videoSourceDeviceId', '41000000-0000-4000-8000-000000000001',
        'width', 1920, 'height', 1080, 'framesPerSecond', 30,
        'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
        'audioBitrateKbps', 160, 'overlayEnabled', true
      )
    ),
    1, 'desired-null-lifecycle', 'start', '{}'::jsonb
  );
  raise exception 'JSON null desired lifecycle should fail.';
exception when others then
  if sqlerrm <> 'INVALID_DESIRED_STATE' then raise; end if;
end;
$$;

do $$
begin
  perform public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001', null,
    1, 'desired-sql-null', 'start', '{}'::jsonb
  );
  raise exception 'SQL null desired state should fail.';
exception when others then
  if sqlerrm <> 'INVALID_DESIRED_STATE' then raise; end if;
end;
$$;

do $$
begin
  perform public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001', '{}'::jsonb,
    1, 'provision-event', 'reconcile', '{}'::jsonb
  );
  raise exception 'Cross-kind command reuse should fail.';
exception when others then
  if sqlerrm <> 'COMMAND_ID_REUSED' then raise; end if;
end;
$$;

select public.production_set_event_status_v1(
  '51000000-0000-4000-8000-000000000001', 'live', 1, 'provision-event-live'
);

do $$
declare
  v_row jsonb;
  v_duplicate jsonb;
begin
  v_row := public.production_register_asset_spec_v1(
    '81000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    'sponsor/main', 'image', 'asset://sponsor/main-v1', repeat('a', 64), 'image/png',
    1920, 1080, null, '{}'::jsonb, 0, 'register-asset'
  );
  perform pg_temp.assert_eq_int((v_row ->> 'version')::int, 1, 'human registers asset version');
  v_duplicate := public.production_register_asset_spec_v1(
    '81000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000001',
    'sponsor/main', 'image', 'asset://sponsor/main-v1', repeat('a', 64), 'image/png',
    1920, 1080, null, '{}'::jsonb, 0, 'register-asset'
  );
  perform pg_temp.assert_eq_int((v_duplicate ->> 'version')::int, 1, 'asset duplicate is idempotent');
  begin
    perform public.production_register_asset_spec_v1(
      '81000000-0000-4000-8000-000000000002',
      '51000000-0000-4000-8000-000000000001',
      'sponsor/main', 'image', 'asset://sponsor/main-v2', repeat('b', 64), 'image/png',
      1920, 1080, null, '{}'::jsonb, 0, 'register-asset-stale'
    );
    raise exception 'Stale asset version should fail.';
  exception when others then
    if sqlerrm <> 'VERSION_CONFLICT:1' then raise; end if;
  end;
end;
$$;

select pg_temp.assert_eq_int(
  (public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'lifecycle', 'running',
      'profile', jsonb_build_object(
        'courtId', (select id::text from public.courts where slug = 'pista-1'),
        'videoSourceDeviceId', '41000000-0000-4000-8000-000000000001',
        'width', 1920, 'height', 1080, 'framesPerSecond', 30,
        'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
        'audioBitrateKbps', 160, 'overlayEnabled', true
      )
    ),
    0, 'desired-typed', 'start', '{}'::jsonb
  ) ->> 'version')::int,
  1,
  'typed desired state succeeds'
);

do $$
begin
  perform public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001',
    jsonb_build_object('running', true),
    1, 'desired-arbitrary', 'start', '{}'::jsonb
  );
  raise exception 'Arbitrary desired JSON should fail.';
exception when others then
  if sqlerrm <> 'INVALID_DESIRED_STATE' then raise; end if;
end;
$$;

do $$
begin
  perform public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'lifecycle', 'running',
      'profile', jsonb_build_object(
        'courtId', null,
        'videoSourceDeviceId', '41000000-0000-4000-8000-000000000001',
        'width', 1920, 'height', 1080, 'framesPerSecond', 30,
        'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
        'audioBitrateKbps', 160, 'overlayEnabled', true
      )
    ),
    1, 'desired-null-court', 'start', '{}'::jsonb
  );
  raise exception 'Null desired court should fail.';
exception when others then
  if sqlerrm <> 'INVALID_DESIRED_STATE' then raise; end if;
end;
$$;

do $$
begin
  perform public.production_set_desired_state_v1(
    '71000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'lifecycle', 'running',
      'profile', jsonb_build_object(
        'courtId', (select id::text from public.courts where slug = 'pista-1'),
        'videoSourceDeviceId', '41000000-0000-4000-8000-000000000001',
        'width', 1920, 'height', 1080, 'framesPerSecond', 30,
        'videoBitrateKbps', 6000, 'audioSourceDeviceId', null,
        'audioBitrateKbps', 160, 'overlayEnabled', true
      )
    ),
    1, 'desired-bad-payload', 'start', jsonb_build_object('executable', 'forbidden')
  );
  raise exception 'Untyped operation payload should fail.';
exception when others then
  if sqlerrm <> 'INVALID_OPERATION_PAYLOAD' then raise; end if;
end;
$$;

do $$
begin
  perform public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'Provisioning day', current_date, 'Europe/Madrid', 'completed', 2, 'complete-live-day'
  );
  raise exception 'Event day with live event should not complete.';
exception when others then
  if sqlerrm <> 'EVENT_DAY_HAS_LIVE_EVENTS' then raise; end if;
end;
$$;

select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_control_commands where command_id = 'provision-day'),
  1,
  'unified command registry stores one immutable reservation'
);

select pg_temp.assert_eq_int(
  (select count(*)::int from public.production_control_commands
    where (coalesce(before_state, '{}'::jsonb)::text || result::text) like '%local://%'),
  0,
  'immutable command snapshots redact local secret references'
);

do $$
begin
  perform secret_ref from public.production_outputs limit 1;
  raise exception 'Browser-capable human should not read output secret refs.';
exception when insufficient_privilege then null;
end;
$$;

reset role;
set local role authenticated;
select pg_temp.use_principal('11000000-0000-4000-8000-000000000002');

do $$
begin
  perform public.production_upsert_output_v1(
    '71000000-0000-4000-8000-000000000009',
    '51000000-0000-4000-8000-000000000001',
    'Forbidden', 'program', 'srt', 'local://outputs/forbidden', true, 0, 'agent-provision'
  );
  raise exception 'Agent provisioning should fail.';
exception when others then
  if sqlerrm <> 'PRINCIPAL_KIND_REQUIRED:human' then raise; end if;
end;
$$;

reset role;
set local role authenticated;
select pg_temp.use_principal('11000000-0000-4000-8000-000000000003');

do $$
begin
  perform public.production_upsert_event_day_v1(
    '00000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000009',
    'Forbidden', current_date, 'Europe/Madrid', 'active', 0, 'device-provision'
  );
  raise exception 'Device provisioning should fail.';
exception when others then
  if sqlerrm <> 'PRINCIPAL_KIND_REQUIRED:human' then raise; end if;
end;
$$;

rollback;
