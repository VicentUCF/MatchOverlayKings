alter default privileges in schema public revoke execute on functions from public;

alter table public.club_users drop constraint club_users_role_check;
alter table public.club_users add constraint club_users_role_check
  check (role in ('admin', 'member'));

alter table public.courts
  add column if not exists production_enabled boolean not null default false;

update public.courts
set production_enabled = slug in ('pista-1', 'pista-2', 'pista-3')
where slug in ('pista-1', 'pista-2', 'pista-3', 'pista-4');

alter table public.courts
  add constraint courts_id_club_key unique (id, club_id);

create table public.production_principals (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('human', 'agent', 'device')),
  display_name text not null check (nullif(btrim(display_name), '') is not null),
  active boolean not null default true,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, club_id),
  unique (club_id, auth_user_id)
);

create unique index production_machine_auth_identity_key
  on public.production_principals(auth_user_id)
  where kind in ('agent', 'device');

create table public.production_principal_roles (
  principal_id uuid not null,
  club_id uuid not null references public.clubs(id) on delete cascade,
  role text not null check (role in ('production_admin', 'operator', 'viewer', 'agent', 'device')),
  created_at timestamptz not null default now(),
  primary key (principal_id, role),
  foreign key (principal_id, club_id)
    references public.production_principals(id, club_id) on delete cascade
);

create table public.production_event_days (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name text not null check (nullif(btrim(name), '') is not null),
  event_date date not null,
  time_zone text not null check (time_zone ~ '^[A-Za-z_]+/[A-Za-z0-9_+/-]+$'),
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'cancelled')),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, club_id)
);

create table public.production_events (
  id uuid primary key,
  event_day_id uuid not null,
  club_id uuid not null references public.clubs(id) on delete cascade,
  court_id uuid not null,
  title text not null check (nullif(btrim(title), '') is not null),
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'ready', 'live', 'completed', 'cancelled')),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end_at > scheduled_start_at),
  foreign key (event_day_id, club_id)
    references public.production_event_days(id, club_id) on delete cascade,
  foreign key (court_id, club_id)
    references public.courts(id, club_id) on delete restrict,
  unique (id, club_id),
  unique (id, court_id, club_id)
);

create unique index production_events_one_live_per_court
  on public.production_events(court_id)
  where status = 'live';

create table public.production_assignments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  event_id uuid not null,
  principal_id uuid not null,
  role text not null check (role in ('operator', 'viewer', 'agent', 'capture')),
  active boolean not null default true,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (event_id, club_id)
    references public.production_events(id, club_id) on delete cascade,
  foreign key (principal_id, club_id)
    references public.production_principals(id, club_id) on delete cascade,
  unique (event_id, principal_id, role)
);

create table public.production_devices (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  principal_id uuid not null unique,
  name text not null check (nullif(btrim(name), '') is not null),
  kind text not null check (kind in ('camera', 'encoder', 'controller', 'display')),
  secret_ref text not null check (secret_ref ~ '^local://[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  enabled boolean not null default true,
  last_heartbeat_at timestamptz,
  heartbeat_status jsonb not null default '{}'::jsonb,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (principal_id, club_id)
    references public.production_principals(id, club_id) on delete cascade,
  unique (id, club_id)
);

create table public.production_outputs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  event_id uuid not null,
  court_id uuid not null,
  name text not null check (nullif(btrim(name), '') is not null),
  kind text not null check (kind in ('program', 'clean', 'preview', 'recording')),
  transport text not null check (transport in ('srt', 'rtmp', 'hls', 'local')),
  secret_ref text check (
    secret_ref is null or secret_ref ~ '^local://[A-Za-z0-9][A-Za-z0-9._/-]*$'
  ),
  enabled boolean not null default true,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (event_id, court_id, club_id)
    references public.production_events(id, court_id, club_id) on delete restrict,
  foreign key (court_id, club_id)
    references public.courts(id, club_id) on delete restrict,
  unique (id, club_id),
  unique (id, event_id, club_id),
  unique (event_id, name)
);

create table public.production_desired_states (
  output_id uuid primary key,
  club_id uuid not null references public.clubs(id) on delete cascade,
  event_id uuid not null,
  version int not null check (version > 0),
  state jsonb not null,
  updated_by_principal_id uuid not null,
  command_id text not null check (nullif(btrim(command_id), '') is not null),
  updated_at timestamptz not null default now(),
  foreign key (output_id, event_id, club_id)
    references public.production_outputs(id, event_id, club_id) on delete restrict,
  foreign key (updated_by_principal_id, club_id)
    references public.production_principals(id, club_id) on delete restrict,
  unique (club_id, command_id)
);

create table public.production_observed_states (
  output_id uuid not null,
  agent_principal_id uuid not null,
  club_id uuid not null references public.clubs(id) on delete cascade,
  event_id uuid not null,
  sequence bigint not null check (sequence >= 0),
  health text not null check (health in ('unknown', 'healthy', 'degraded', 'failed', 'offline')),
  state jsonb not null,
  reported_at timestamptz not null default now(),
  primary key (output_id, agent_principal_id),
  foreign key (output_id, event_id, club_id)
    references public.production_outputs(id, event_id, club_id) on delete restrict,
  foreign key (agent_principal_id, club_id)
    references public.production_principals(id, club_id) on delete cascade
);

create table public.production_operations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete restrict,
  event_id uuid not null,
  court_id uuid not null,
  output_id uuid,
  command_id text not null check (nullif(btrim(command_id), '') is not null),
  kind text not null check (kind in ('start', 'stop', 'reconcile', 'reload', 'take', 'clear')),
  payload jsonb not null,
  before_state jsonb,
  after_state jsonb not null,
  requested_by_principal_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (event_id, club_id)
    references public.production_events(id, club_id) on delete restrict,
  foreign key (court_id, club_id)
    references public.courts(id, club_id) on delete restrict,
  foreign key (output_id, club_id)
    references public.production_outputs(id, club_id) on delete restrict,
  foreign key (requested_by_principal_id, club_id)
    references public.production_principals(id, club_id) on delete restrict,
  unique (club_id, command_id)
);

create table public.production_operation_claims (
  operation_id uuid primary key references public.production_operations(id) on delete cascade,
  agent_principal_id uuid not null,
  club_id uuid not null references public.clubs(id) on delete restrict,
  status text not null default 'claimed' check (status in ('claimed', 'completed', 'failed')),
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  result jsonb,
  completed_at timestamptz,
  foreign key (agent_principal_id, club_id)
    references public.production_principals(id, club_id) on delete cascade
);

create table public.production_asset_specs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete restrict,
  event_id uuid not null,
  key text not null check (key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  version int not null check (version > 0),
  kind text not null check (kind in ('image', 'video', 'audio', 'font', 'template')),
  uri text not null check (uri ~ '^asset://[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text not null check (media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  width int check (width > 0),
  height int check (height > 0),
  duration_ms int check (duration_ms >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (event_id, club_id)
    references public.production_events(id, club_id) on delete restrict,
  unique (event_id, key, version)
);

create table public.production_event_commands (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete restrict,
  event_id uuid not null,
  actor_principal_id uuid not null,
  command_id text not null check (nullif(btrim(command_id), '') is not null),
  type text not null check (type in ('schedule', 'set_status')),
  before_state jsonb,
  after_state jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (event_id, club_id)
    references public.production_events(id, club_id) on delete restrict,
  foreign key (actor_principal_id, club_id)
    references public.production_principals(id, club_id) on delete restrict,
  unique (club_id, command_id)
);

create table public.production_control_commands (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete restrict,
  actor_principal_id uuid not null,
  command_id text not null check (nullif(btrim(command_id), '') is not null),
  resource_kind text not null check (
    resource_kind in ('event_day', 'principal', 'device', 'assignment', 'output', 'asset_spec', 'event_schedule', 'event_status', 'desired_state', 'human_role')
  ),
  resource_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  before_state jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (actor_principal_id, club_id)
    references public.production_principals(id, club_id) on delete restrict,
  unique (club_id, command_id)
);

create or replace function public.production_sync_human_principal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_principal_id uuid;
begin
  select id into v_principal_id
  from public.production_principals
  where auth_user_id = new.user_id and club_id = new.club_id;

  if v_principal_id is null then
    insert into public.production_principals (club_id, auth_user_id, kind, display_name)
    values (new.club_id, new.user_id, 'human', 'Production user')
    returning id into v_principal_id;
  elsif not exists (
    select 1 from public.production_principals
    where id = v_principal_id and kind = 'human'
  ) then
    raise exception 'PRINCIPAL_KIND_MISMATCH';
  end if;

  if new.role = 'admin' then
    insert into public.production_principal_roles (principal_id, club_id, role)
    values (v_principal_id, new.club_id, 'production_admin')
    on conflict do nothing;
  else
    delete from public.production_principal_roles
    where principal_id = v_principal_id and club_id = new.club_id
      and role = 'production_admin';
  end if;
  return new;
end;
$$;

create trigger production_club_user_identity
after insert or update of role on public.club_users
for each row execute function public.production_sync_human_principal();

insert into public.production_principals (club_id, auth_user_id, kind, display_name)
select club_id, user_id, 'human', 'Production user'
from public.club_users
on conflict (club_id, auth_user_id) do nothing;

insert into public.production_principal_roles (principal_id, club_id, role)
select p.id, p.club_id, 'production_admin'
from public.production_principals p
join public.club_users cu on cu.club_id = p.club_id and cu.user_id = p.auth_user_id
where p.kind = 'human' and cu.role = 'admin'
on conflict do nothing;

create or replace function public.production_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'IMMUTABLE_RECORD';
end;
$$;

create trigger production_operations_immutable
before update or delete on public.production_operations
for each row execute function public.production_prevent_mutation();

create trigger production_event_commands_immutable
before update or delete on public.production_event_commands
for each row execute function public.production_prevent_mutation();

create trigger production_control_commands_immutable
before update or delete on public.production_control_commands
for each row execute function public.production_prevent_mutation();

create trigger production_asset_specs_immutable
before update or delete on public.production_asset_specs
for each row execute function public.production_prevent_mutation();

create or replace function public.production_validate_principal_role()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select kind into v_kind
  from public.production_principals
  where id = new.principal_id and club_id = new.club_id;

  if not (
    (v_kind = 'human' and new.role in ('production_admin', 'operator', 'viewer'))
    or (v_kind = 'agent' and new.role = 'agent')
    or (v_kind = 'device' and new.role = 'device')
  ) then
    raise exception 'ROLE_KIND_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger production_principal_role_kind
before insert or update on public.production_principal_roles
for each row execute function public.production_validate_principal_role();

create or replace function public.production_validate_assignment()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select kind into v_kind
  from public.production_principals
  where id = new.principal_id and club_id = new.club_id;

  if not (
    (v_kind = 'human' and new.role in ('operator', 'viewer'))
    or (v_kind = 'agent' and new.role = 'agent')
    or (v_kind = 'device' and new.role = 'capture')
  ) then
    raise exception 'ASSIGNMENT_KIND_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger production_assignment_kind
before insert or update on public.production_assignments
for each row execute function public.production_validate_assignment();

create or replace function public.production_validate_device()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.production_principals p
    where p.id = new.principal_id and p.club_id = new.club_id and p.kind = 'device'
  ) then
    raise exception 'DEVICE_PRINCIPAL_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger production_device_identity
before insert or update on public.production_devices
for each row execute function public.production_validate_device();

create or replace function public.production_validate_output_court()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.production_events e
    where e.id = new.event_id and e.club_id = new.club_id and e.court_id = new.court_id
  ) then
    raise exception 'OUTPUT_COURT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger production_output_court
before insert or update on public.production_outputs
for each row execute function public.production_validate_output_court();

create or replace function public.production_guard_event_identity()
returns trigger
language plpgsql
as $$
begin
  if old.court_id is distinct from new.court_id and exists (
    select 1 from public.production_outputs o where o.event_id = old.id
  ) then raise exception 'EVENT_COURT_HAS_OUTPUTS'; end if;
  return new;
end;
$$;

create trigger production_event_identity
before update of court_id on public.production_events
for each row execute function public.production_guard_event_identity();

create or replace function public.production_guard_output_identity()
returns trigger
language plpgsql
as $$
begin
  if old.event_id is distinct from new.event_id
    or old.court_id is distinct from new.court_id
    or old.club_id is distinct from new.club_id then
    raise exception 'OUTPUT_EVENT_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger production_output_identity
before update of event_id, court_id, club_id on public.production_outputs
for each row execute function public.production_guard_output_identity();

create or replace function public.production_guard_event_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('ready', 'live') and old.status is distinct from new.status then
    if not exists (
      select 1 from public.courts c
      where c.id = new.court_id and c.club_id = new.club_id and c.production_enabled
    ) then
      raise exception 'COURT_DISABLED';
    end if;

    if not exists (
      select 1 from public.production_event_days d
      where d.id = new.event_day_id and d.club_id = new.club_id and d.status = 'active'
    ) then
      raise exception 'EVENT_DAY_NOT_ACTIVE';
    end if;

    if current_timestamp >= new.scheduled_end_at
      or (new.status = 'live' and current_timestamp < new.scheduled_start_at) then
      raise exception 'OUTSIDE_SCHEDULE_WINDOW';
    end if;

    if not exists (
      select 1 from public.production_outputs o
      where o.event_id = new.id and o.club_id = new.club_id
        and o.kind = 'program' and o.enabled
    ) then raise exception 'PROGRAM_OUTPUT_REQUIRED'; end if;

    if not exists (
      select 1 from public.production_assignments a
      join public.production_principals p
        on p.id = a.principal_id and p.club_id = a.club_id
      where a.event_id = new.id and a.club_id = new.club_id
        and a.role = 'agent' and a.active and p.kind = 'agent' and p.active
    ) then raise exception 'ACTIVE_AGENT_REQUIRED'; end if;

    if not exists (
      select 1 from public.production_assignments a
      join public.production_principals p
        on p.id = a.principal_id and p.club_id = a.club_id
      join public.production_devices d
        on d.principal_id = p.id and d.club_id = p.club_id
      where a.event_id = new.id and a.club_id = new.club_id
        and a.role = 'capture' and a.active and p.kind = 'device' and p.active
        and d.enabled and d.kind in ('camera', 'encoder')
    ) then raise exception 'ACTIVE_CAPTURE_REQUIRED'; end if;
  end if;

  if new.status in ('completed', 'cancelled') and exists (
    select 1 from public.production_desired_states ds
    where ds.event_id = new.id and ds.state ->> 'lifecycle' in ('preflight', 'running')
  ) then
    raise exception 'EVENT_HAS_ACTIVE_OUTPUTS';
  end if;
  return new;
end;
$$;

create trigger production_event_lifecycle
before insert or update of status on public.production_events
for each row execute function public.production_guard_event_lifecycle();

create or replace function public.production_current_principal_id(p_club_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.production_principals
  where auth_user_id = auth.uid() and club_id = p_club_id and active
  limit 1;
$$;

create or replace function public.production_human_can_read(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.production_principals p
    join public.club_users cu on cu.club_id = p.club_id and cu.user_id = p.auth_user_id
    where p.auth_user_id = auth.uid()
      and p.club_id = p_club_id
      and p.kind = 'human'
      and p.active
  );
$$;

create or replace function public.production_human_can_manage(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.production_principals p
    join public.production_principal_roles r on r.principal_id = p.id and r.club_id = p.club_id
    join public.club_users cu on cu.club_id = p.club_id and cu.user_id = p.auth_user_id
    where p.auth_user_id = auth.uid()
      and p.club_id = p_club_id
      and p.kind = 'human'
      and p.active
      and r.role in ('production_admin', 'operator')
  );
$$;

create or replace function public.production_agent_assigned(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.production_principals p
    join public.production_assignments a on a.principal_id = p.id and a.club_id = p.club_id
    join public.production_events e on e.id = a.event_id and e.club_id = a.club_id
    where p.auth_user_id = auth.uid()
      and p.kind = 'agent'
      and p.active
      and e.id = p_event_id
      and a.role = 'agent'
      and a.active
  );
$$;

create or replace function public.production_require_principal(p_kind text, p_club_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_principal_id uuid;
begin
  select id into v_principal_id
  from public.production_principals
  where auth_user_id = auth.uid()
    and kind = p_kind
    and active
    and (p_club_id is null or club_id = p_club_id);

  if v_principal_id is null then
    raise exception 'PRINCIPAL_KIND_REQUIRED:%', p_kind;
  end if;
  return v_principal_id;
end;
$$;

create or replace function public.production_require_human_manager(p_club_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_principal_id uuid := public.production_require_principal('human', p_club_id);
begin
  if not public.production_human_can_manage(p_club_id) then
    raise exception 'FORBIDDEN';
  end if;
  return v_principal_id;
end;
$$;

create or replace function public.production_require_human_admin(p_club_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_principal_id uuid := public.production_require_principal('human', p_club_id);
begin
  if not exists (
    select 1 from public.production_principal_roles r
    where r.principal_id = v_principal_id and r.club_id = p_club_id
      and r.role = 'production_admin'
  ) then raise exception 'FORBIDDEN'; end if;
  return v_principal_id;
end;
$$;

create or replace function public.production_prepare_command(p_request jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform set_config(
    'production.request_fingerprint',
    public.encode(public.digest(pg_catalog.convert_to(p_request::text, 'UTF8'), 'sha256'), 'hex'),
    true
  );
end;
$$;

create or replace function public.production_existing_control_command(
  p_club_id uuid,
  p_command_id text,
  p_resource_kind text,
  p_resource_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_command public.production_control_commands%rowtype;
  v_fingerprint text := current_setting('production.request_fingerprint', true);
begin
  if nullif(btrim(p_command_id), '') is null then raise exception 'COMMAND_ID_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_club_id::text || ':' || p_command_id, 0));
  select * into v_command
  from public.production_control_commands
  where club_id = p_club_id and command_id = p_command_id;

  if not found then return null; end if;
  if v_command.resource_kind <> p_resource_kind or v_command.resource_id <> p_resource_id
    or v_command.request_fingerprint <> v_fingerprint then
    raise exception 'COMMAND_ID_REUSED';
  end if;
  return v_command.result;
end;
$$;

create or replace function public.production_record_control_command(
  p_club_id uuid,
  p_actor_principal_id uuid,
  p_command_id text,
  p_resource_kind text,
  p_resource_id uuid,
  p_before_state jsonb,
  p_result jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.production_control_commands (
    club_id, actor_principal_id, command_id, resource_kind, resource_id,
    request_fingerprint, before_state, result
  ) values (
    p_club_id, p_actor_principal_id, p_command_id, p_resource_kind, p_resource_id,
    current_setting('production.request_fingerprint'), p_before_state, p_result
  );
$$;

create or replace function public.production_validate_desired_state_v1(
  p_desired jsonb,
  p_club_id uuid,
  p_event_id uuid,
  p_court_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile jsonb;
  v_video_device_id uuid;
  v_audio_device_id uuid;
begin
  if p_desired is null
    or jsonb_typeof(p_desired) <> 'object'
    or not (p_desired ? 'lifecycle' and p_desired ? 'profile')
    or exists (
      select 1 from jsonb_object_keys(p_desired) as item(value)
      where value not in ('lifecycle', 'profile')
    )
    or coalesce(jsonb_typeof(p_desired -> 'lifecycle'), '') <> 'string'
    or p_desired ->> 'lifecycle' not in ('off', 'preflight', 'running', 'stopped') then
    raise exception 'INVALID_DESIRED_STATE';
  end if;

  v_profile := p_desired -> 'profile';
  if jsonb_typeof(v_profile) <> 'object'
    or not (
      v_profile ? 'courtId' and v_profile ? 'videoSourceDeviceId'
      and v_profile ? 'width' and v_profile ? 'height' and v_profile ? 'framesPerSecond'
      and v_profile ? 'videoBitrateKbps' and v_profile ? 'audioSourceDeviceId'
      and v_profile ? 'audioBitrateKbps' and v_profile ? 'overlayEnabled'
    )
    or exists (
      select 1 from jsonb_object_keys(v_profile) as item(value)
      where value not in (
        'courtId', 'videoSourceDeviceId', 'width', 'height', 'framesPerSecond',
        'videoBitrateKbps', 'audioSourceDeviceId', 'audioBitrateKbps', 'overlayEnabled'
      )
    )
    or coalesce(jsonb_typeof(v_profile -> 'courtId'), '') <> 'string'
    or v_profile ->> 'courtId' <> p_court_id::text
    or coalesce(jsonb_typeof(v_profile -> 'videoSourceDeviceId'), '') <> 'string'
    or coalesce(jsonb_typeof(v_profile -> 'width'), '') <> 'number'
    or coalesce(jsonb_typeof(v_profile -> 'height'), '') <> 'number'
    or coalesce(jsonb_typeof(v_profile -> 'framesPerSecond'), '') <> 'number'
    or coalesce(jsonb_typeof(v_profile -> 'videoBitrateKbps'), '') <> 'number'
    or coalesce(jsonb_typeof(v_profile -> 'audioBitrateKbps'), '') <> 'number'
    or coalesce(jsonb_typeof(v_profile -> 'overlayEnabled'), '') <> 'boolean'
    or coalesce(jsonb_typeof(v_profile -> 'audioSourceDeviceId'), '') not in ('string', 'null') then
    raise exception 'INVALID_DESIRED_STATE';
  end if;

  if (v_profile ->> 'width')::numeric <> trunc((v_profile ->> 'width')::numeric)
    or (v_profile ->> 'width')::numeric not between 640 and 7680
    or (v_profile ->> 'height')::numeric <> trunc((v_profile ->> 'height')::numeric)
    or (v_profile ->> 'height')::numeric not between 360 and 4320
    or (v_profile ->> 'framesPerSecond')::numeric <> trunc((v_profile ->> 'framesPerSecond')::numeric)
    or (v_profile ->> 'framesPerSecond')::numeric not between 24 and 120
    or (v_profile ->> 'videoBitrateKbps')::numeric <> trunc((v_profile ->> 'videoBitrateKbps')::numeric)
    or (v_profile ->> 'videoBitrateKbps')::numeric not between 500 and 100000
    or (v_profile ->> 'audioBitrateKbps')::numeric <> trunc((v_profile ->> 'audioBitrateKbps')::numeric)
    or (v_profile ->> 'audioBitrateKbps')::numeric not between 32 and 512 then
    raise exception 'INVALID_DESIRED_STATE';
  end if;

  begin
    v_video_device_id := (v_profile ->> 'videoSourceDeviceId')::uuid;
    if v_profile -> 'audioSourceDeviceId' <> 'null'::jsonb then
      v_audio_device_id := (v_profile ->> 'audioSourceDeviceId')::uuid;
    end if;
  exception when invalid_text_representation then
    raise exception 'INVALID_DESIRED_STATE';
  end;

  if not exists (
    select 1
    from public.production_devices d
    join public.production_assignments a on a.principal_id = d.principal_id
    where d.id = v_video_device_id and d.club_id = p_club_id and d.enabled
      and d.kind = 'camera'
      and a.event_id = p_event_id and a.role = 'capture' and a.active
  ) then raise exception 'INVALID_DESIRED_STATE'; end if;

  if v_audio_device_id is not null and not exists (
    select 1
    from public.production_devices d
    join public.production_assignments a on a.principal_id = d.principal_id
    where d.id = v_audio_device_id and d.club_id = p_club_id and d.enabled
      and d.kind in ('camera', 'encoder')
      and a.event_id = p_event_id and a.role = 'capture' and a.active
  ) then raise exception 'INVALID_DESIRED_STATE'; end if;

  return p_desired;
end;
$$;

create or replace function public.production_event_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select case p_from
    when 'scheduled' then p_to in ('ready', 'live', 'cancelled')
    when 'ready' then p_to in ('scheduled', 'live', 'cancelled')
    when 'live' then p_to = 'completed'
    else false
  end;
$$;

create or replace function public.production_event_day_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select p_from = p_to or case p_from
    when 'draft' then p_to in ('active', 'cancelled')
    when 'active' then p_to in ('completed', 'cancelled')
    else false
  end;
$$;

alter table public.production_principals enable row level security;
alter table public.production_principal_roles enable row level security;
alter table public.production_event_days enable row level security;
alter table public.production_events enable row level security;
alter table public.production_assignments enable row level security;
alter table public.production_devices enable row level security;
alter table public.production_outputs enable row level security;
alter table public.production_desired_states enable row level security;
alter table public.production_observed_states enable row level security;
alter table public.production_operations enable row level security;
alter table public.production_operation_claims enable row level security;
alter table public.production_asset_specs enable row level security;
alter table public.production_event_commands enable row level security;
alter table public.production_control_commands enable row level security;

create policy "production principals human club or self read"
on public.production_principals for select to authenticated
using (public.production_human_can_read(club_id) or auth_user_id = auth.uid());

create policy "production roles human club or self read"
on public.production_principal_roles for select to authenticated
using (
  public.production_human_can_read(club_id)
  or principal_id = public.production_current_principal_id(club_id)
);

create policy "production event days human or assigned agent read"
on public.production_event_days for select to authenticated
using (
  public.production_human_can_read(club_id)
  or exists (
    select 1 from public.production_events e
    where e.event_day_id = production_event_days.id
      and public.production_agent_assigned(e.id)
  )
);

create policy "production events human or assigned agent read"
on public.production_events for select to authenticated
using (public.production_human_can_read(club_id) or public.production_agent_assigned(id));

create policy "production assignments human or own agent read"
on public.production_assignments for select to authenticated
using (
  public.production_human_can_read(club_id)
  or (
    principal_id = public.production_current_principal_id(club_id)
    and public.production_agent_assigned(event_id)
  )
);

create policy "production devices human or own device read"
on public.production_devices for select to authenticated
using (
  public.production_human_can_read(club_id)
  or principal_id = public.production_current_principal_id(club_id)
);

create policy "production outputs human or assigned agent read"
on public.production_outputs for select to authenticated
using (public.production_human_can_read(club_id) or public.production_agent_assigned(event_id));

create policy "production desired human or assigned agent read"
on public.production_desired_states for select to authenticated
using (public.production_human_can_read(club_id) or public.production_agent_assigned(event_id));

create policy "production observed human or reporting agent read"
on public.production_observed_states for select to authenticated
using (
  public.production_human_can_read(club_id)
  or (
    agent_principal_id = public.production_current_principal_id(club_id)
    and public.production_agent_assigned(event_id)
  )
);

create policy "production operations human or assigned agent read"
on public.production_operations for select to authenticated
using (public.production_human_can_read(club_id) or public.production_agent_assigned(event_id));

create policy "production claims human or claiming agent read"
on public.production_operation_claims for select to authenticated
using (
  public.production_human_can_read(club_id)
  or agent_principal_id = public.production_current_principal_id(club_id)
);

create policy "production assets human or assigned agent read"
on public.production_asset_specs for select to authenticated
using (
  public.production_human_can_read(club_id)
  or public.production_agent_assigned(event_id)
);

create policy "production event commands human read"
on public.production_event_commands for select to authenticated
using (public.production_human_can_read(club_id));

create policy "production control commands human read"
on public.production_control_commands for select to authenticated
using (public.production_human_can_read(club_id));

create or replace function public.production_upsert_event_day_v1(
  p_club_id uuid,
  p_event_day_id uuid,
  p_name text,
  p_event_date date,
  p_time_zone text,
  p_status text,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day public.production_event_days%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  perform 1 from public.clubs where id = p_club_id for update;
  if not found then raise exception 'CLUB_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(p_club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'clubId', p_club_id, 'eventDayId', p_event_day_id, 'name', p_name,
    'eventDate', p_event_date, 'timeZone', p_time_zone, 'status', p_status,
    'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    p_club_id, p_command_id, 'event_day', p_event_day_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'NAME_REQUIRED'; end if;
  if p_time_zone !~ '^[A-Za-z_]+/[A-Za-z0-9_+/-]+$' then raise exception 'INVALID_TIME_ZONE'; end if;
  if p_status not in ('draft', 'active', 'completed', 'cancelled') then raise exception 'INVALID_EVENT_DAY_STATUS'; end if;

  select * into v_day from public.production_event_days where id = p_event_day_id for update;
  if found then
    if v_day.club_id <> p_club_id then raise exception 'FORBIDDEN'; end if;
    if v_day.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_day.version; end if;
    if not public.production_event_day_transition_allowed(v_day.status, p_status) then
      raise exception 'INVALID_EVENT_DAY_TRANSITION:%->%', v_day.status, p_status;
    end if;
    if p_status in ('completed', 'cancelled') and exists (
      select 1 from public.production_events
      where event_day_id = p_event_day_id and status = 'live'
    ) then raise exception 'EVENT_DAY_HAS_LIVE_EVENTS'; end if;
    if p_status in ('completed', 'cancelled') and exists (
      select 1 from public.production_desired_states ds
      join public.production_events e on e.id = ds.event_id and e.club_id = ds.club_id
      where e.event_day_id = p_event_day_id
        and ds.state ->> 'lifecycle' in ('preflight', 'running')
    ) then raise exception 'EVENT_DAY_HAS_ACTIVE_OUTPUTS'; end if;
    v_before := to_jsonb(v_day);
    update public.production_event_days
    set name = btrim(p_name), event_date = p_event_date, time_zone = p_time_zone,
        status = p_status, version = version + 1, updated_at = now()
    where id = p_event_day_id
    returning * into v_day;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_event_days (id, club_id, name, event_date, time_zone, status)
    values (p_event_day_id, p_club_id, btrim(p_name), p_event_date, p_time_zone, p_status)
    returning * into v_day;
  end if;

  perform public.production_record_control_command(
    p_club_id, v_actor_id, p_command_id, 'event_day', p_event_day_id, v_before, to_jsonb(v_day)
  );
  return to_jsonb(v_day);
end;
$$;

create or replace function public.production_upsert_machine_principal_v1(
  p_principal_id uuid,
  p_club_id uuid,
  p_auth_user_id uuid,
  p_kind text,
  p_display_name text,
  p_active boolean,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_principal public.production_principals%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  perform 1 from public.clubs where id = p_club_id for update;
  if not found then raise exception 'CLUB_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(p_club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'principalId', p_principal_id, 'clubId', p_club_id, 'authUserId', p_auth_user_id,
    'kind', p_kind, 'displayName', p_display_name, 'active', p_active,
    'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    p_club_id, p_command_id, 'principal', p_principal_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if p_kind not in ('agent', 'device') then raise exception 'MACHINE_PRINCIPAL_KIND_REQUIRED'; end if;
  if nullif(btrim(p_display_name), '') is null then raise exception 'NAME_REQUIRED'; end if;

  select * into v_principal from public.production_principals where id = p_principal_id for update;
  if found then
    if v_principal.club_id <> p_club_id
      or v_principal.auth_user_id <> p_auth_user_id
      or v_principal.kind <> p_kind then raise exception 'PRINCIPAL_IDENTITY_IMMUTABLE'; end if;
    if v_principal.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_principal.version; end if;
    v_before := to_jsonb(v_principal);
    update public.production_principals
    set display_name = btrim(p_display_name), active = p_active,
        version = version + 1, updated_at = now()
    where id = p_principal_id
    returning * into v_principal;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_principals (
      id, club_id, auth_user_id, kind, display_name, active
    ) values (
      p_principal_id, p_club_id, p_auth_user_id, p_kind, btrim(p_display_name), p_active
    ) returning * into v_principal;
  end if;

  insert into public.production_principal_roles (principal_id, club_id, role)
  values (v_principal.id, v_principal.club_id, p_kind)
  on conflict do nothing;
  perform public.production_record_control_command(
    p_club_id, v_actor_id, p_command_id, 'principal', p_principal_id,
    v_before, to_jsonb(v_principal)
  );
  return to_jsonb(v_principal);
end;
$$;

create or replace function public.production_upsert_device_v1(
  p_device_id uuid,
  p_principal_id uuid,
  p_name text,
  p_kind text,
  p_secret_ref text,
  p_enabled boolean,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_principal public.production_principals%rowtype;
  v_device public.production_devices%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  select * into v_principal
  from public.production_principals where id = p_principal_id for update;
  if not found or v_principal.kind <> 'device' then raise exception 'DEVICE_PRINCIPAL_REQUIRED'; end if;
  v_actor_id := public.production_require_human_manager(v_principal.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'deviceId', p_device_id, 'principalId', p_principal_id, 'name', p_name,
    'kind', p_kind, 'secretRef', p_secret_ref, 'enabled', p_enabled,
    'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_principal.club_id, p_command_id, 'device', p_device_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'NAME_REQUIRED'; end if;
  if p_kind not in ('camera', 'encoder', 'controller', 'display') then raise exception 'INVALID_DEVICE_KIND'; end if;
  if p_secret_ref is null or p_secret_ref !~ '^local://[A-Za-z0-9][A-Za-z0-9._/-]*$' then
    raise exception 'LOCAL_SECRET_REF_REQUIRED';
  end if;

  select * into v_device from public.production_devices where id = p_device_id for update;
  if found then
    if v_device.club_id <> v_principal.club_id or v_device.principal_id <> p_principal_id then
      raise exception 'DEVICE_IDENTITY_IMMUTABLE';
    end if;
    if v_device.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_device.version; end if;
    v_before := to_jsonb(v_device) - 'secret_ref';
    update public.production_devices
    set name = btrim(p_name), kind = p_kind, secret_ref = p_secret_ref, enabled = p_enabled,
        version = version + 1, updated_at = now()
    where id = p_device_id
    returning * into v_device;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_devices (
      id, club_id, principal_id, name, kind, secret_ref, enabled
    ) values (
      p_device_id, v_principal.club_id, p_principal_id, btrim(p_name), p_kind,
      p_secret_ref, p_enabled
    ) returning * into v_device;
  end if;

  perform public.production_record_control_command(
    v_device.club_id, v_actor_id, p_command_id, 'device', p_device_id,
    v_before, to_jsonb(v_device) - 'secret_ref'
  );
  return to_jsonb(v_device) - 'secret_ref';
end;
$$;

create or replace function public.production_upsert_assignment_v1(
  p_assignment_id uuid,
  p_event_id uuid,
  p_principal_id uuid,
  p_role text,
  p_active boolean,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.production_events%rowtype;
  v_assignment public.production_assignments%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  select * into v_event from public.production_events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(v_event.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'assignmentId', p_assignment_id, 'eventId', p_event_id,
    'principalId', p_principal_id, 'role', p_role, 'active', p_active,
    'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_event.club_id, p_command_id, 'assignment', p_assignment_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if not exists (
    select 1 from public.production_principals
    where id = p_principal_id and club_id = v_event.club_id
  ) then raise exception 'PRINCIPAL_NOT_FOUND'; end if;

  select * into v_assignment
  from public.production_assignments where id = p_assignment_id for update;
  if found then
    if v_assignment.club_id <> v_event.club_id then raise exception 'FORBIDDEN'; end if;
    if v_assignment.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_assignment.version; end if;
    v_before := to_jsonb(v_assignment);
    update public.production_assignments
    set event_id = p_event_id, principal_id = p_principal_id, role = p_role,
        active = p_active, version = version + 1, updated_at = now()
    where id = p_assignment_id
    returning * into v_assignment;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_assignments (
      id, club_id, event_id, principal_id, role, active
    ) values (
      p_assignment_id, v_event.club_id, p_event_id, p_principal_id, p_role, p_active
    ) returning * into v_assignment;
  end if;

  perform public.production_record_control_command(
    v_event.club_id, v_actor_id, p_command_id, 'assignment', p_assignment_id,
    v_before, to_jsonb(v_assignment)
  );
  return to_jsonb(v_assignment);
end;
$$;

create or replace function public.production_upsert_output_v1(
  p_output_id uuid,
  p_event_id uuid,
  p_name text,
  p_kind text,
  p_transport text,
  p_secret_ref text,
  p_enabled boolean,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.production_events%rowtype;
  v_output public.production_outputs%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  select * into v_event from public.production_events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(v_event.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'outputId', p_output_id, 'eventId', p_event_id, 'name', p_name,
    'kind', p_kind, 'transport', p_transport, 'secretRef', p_secret_ref,
    'enabled', p_enabled, 'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_event.club_id, p_command_id, 'output', p_output_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'NAME_REQUIRED'; end if;
  if p_kind not in ('program', 'clean', 'preview', 'recording') then raise exception 'INVALID_OUTPUT_KIND'; end if;
  if p_transport not in ('srt', 'rtmp', 'hls', 'local') then raise exception 'INVALID_OUTPUT_TRANSPORT'; end if;
  if p_secret_ref is not null and p_secret_ref !~ '^local://[A-Za-z0-9][A-Za-z0-9._/-]*$' then
    raise exception 'LOCAL_SECRET_REF_REQUIRED';
  end if;

  select * into v_output from public.production_outputs where id = p_output_id for update;
  if found then
    if v_output.club_id <> v_event.club_id then raise exception 'FORBIDDEN'; end if;
    if v_output.event_id <> p_event_id then raise exception 'OUTPUT_EVENT_IDENTITY_IMMUTABLE'; end if;
    if v_output.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_output.version; end if;
    v_before := to_jsonb(v_output) - 'secret_ref';
    update public.production_outputs
    set name = btrim(p_name),
        kind = p_kind, transport = p_transport, secret_ref = p_secret_ref,
        enabled = p_enabled, version = version + 1, updated_at = now()
    where id = p_output_id
    returning * into v_output;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_outputs (
      id, club_id, event_id, court_id, name, kind, transport, secret_ref, enabled
    ) values (
      p_output_id, v_event.club_id, p_event_id, v_event.court_id, btrim(p_name),
      p_kind, p_transport, p_secret_ref, p_enabled
    ) returning * into v_output;
  end if;

  perform public.production_record_control_command(
    v_event.club_id, v_actor_id, p_command_id, 'output', p_output_id,
    v_before, to_jsonb(v_output) - 'secret_ref'
  );
  return to_jsonb(v_output) - 'secret_ref';
end;
$$;

create or replace function public.production_register_asset_spec_v1(
  p_asset_spec_id uuid,
  p_event_id uuid,
  p_key text,
  p_kind text,
  p_uri text,
  p_sha256 text,
  p_media_type text,
  p_width int,
  p_height int,
  p_duration_ms int,
  p_metadata jsonb,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.production_events%rowtype;
  v_asset public.production_asset_specs%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_current_version int;
begin
  select * into v_event from public.production_events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(v_event.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'assetSpecId', p_asset_spec_id, 'eventId', p_event_id, 'key', p_key,
    'kind', p_kind, 'uri', p_uri, 'sha256', p_sha256, 'mediaType', p_media_type,
    'width', p_width, 'height', p_height, 'durationMs', p_duration_ms,
    'metadata', p_metadata, 'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_event.club_id, p_command_id, 'asset_spec', p_asset_spec_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if p_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' then raise exception 'INVALID_ASSET_KEY'; end if;
  if p_uri !~ '^asset://[A-Za-z0-9][A-Za-z0-9._/-]*$' then raise exception 'INVALID_ASSET_URI'; end if;
  if p_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_ASSET_SHA256'; end if;
  if p_media_type !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' then raise exception 'INVALID_MEDIA_TYPE'; end if;
  if p_kind not in ('image', 'video', 'audio', 'font', 'template') then raise exception 'INVALID_ASSET_KIND'; end if;
  if exists (select 1 from public.production_asset_specs where id = p_asset_spec_id) then
    raise exception 'ASSET_SPEC_ID_EXISTS';
  end if;

  select coalesce(max(version), 0) into v_current_version
  from public.production_asset_specs
  where event_id = p_event_id and key = p_key;
  if v_current_version <> p_expected_version then
    raise exception 'VERSION_CONFLICT:%', v_current_version;
  end if;

  insert into public.production_asset_specs (
    id, club_id, event_id, key, version, kind, uri, sha256, media_type,
    width, height, duration_ms, metadata
  ) values (
    p_asset_spec_id, v_event.club_id, p_event_id, p_key, v_current_version + 1,
    p_kind, p_uri, p_sha256, p_media_type, p_width, p_height, p_duration_ms, p_metadata
  ) returning * into v_asset;
  perform public.production_record_control_command(
    v_event.club_id, v_actor_id, p_command_id, 'asset_spec', p_asset_spec_id,
    null, to_jsonb(v_asset)
  );
  return to_jsonb(v_asset);
end;
$$;

create or replace function public.production_schedule_event_v1(
  p_event_id uuid,
  p_event_day_id uuid,
  p_court_slug text,
  p_title text,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at timestamptz,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_court public.courts%rowtype;
  v_event public.production_events%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  if nullif(btrim(p_command_id), '') is null then raise exception 'COMMAND_ID_REQUIRED'; end if;
  if nullif(btrim(p_title), '') is null then raise exception 'TITLE_REQUIRED'; end if;
  if p_scheduled_end_at <= p_scheduled_start_at then raise exception 'INVALID_SCHEDULE_WINDOW'; end if;

  select * into v_court from public.courts where slug = p_court_slug for update;
  if not found then raise exception 'COURT_NOT_FOUND'; end if;
  if not exists (
    select 1 from public.production_event_days d
    where d.id = p_event_day_id and d.club_id = v_court.club_id
  ) then raise exception 'EVENT_DAY_NOT_FOUND'; end if;

  v_actor_id := public.production_require_human_manager(v_court.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'eventId', p_event_id, 'eventDayId', p_event_day_id, 'courtSlug', p_court_slug,
    'title', p_title, 'scheduledStartAt', p_scheduled_start_at,
    'scheduledEndAt', p_scheduled_end_at, 'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_court.club_id, p_command_id, 'event_schedule', p_event_id
  );
  if v_duplicate is not null then return v_duplicate; end if;

  select * into v_event from public.production_events where id = p_event_id for update;
  if found then
    if v_event.club_id <> v_court.club_id then raise exception 'FORBIDDEN'; end if;
    if v_event.status not in ('scheduled', 'ready') then raise exception 'EVENT_NOT_RESCHEDULABLE'; end if;
    if v_event.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_event.version; end if;
    v_before := to_jsonb(v_event);
    update public.production_events
    set event_day_id = p_event_day_id,
        court_id = v_court.id,
        title = btrim(p_title),
        scheduled_start_at = p_scheduled_start_at,
        scheduled_end_at = p_scheduled_end_at,
        version = version + 1,
        updated_at = now()
    where id = p_event_id
    returning * into v_event;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_events (
      id, event_day_id, club_id, court_id, title, scheduled_start_at, scheduled_end_at
    ) values (
      p_event_id, p_event_day_id, v_court.club_id, v_court.id, btrim(p_title),
      p_scheduled_start_at, p_scheduled_end_at
    ) returning * into v_event;
  end if;

  insert into public.production_event_commands (
    club_id, event_id, actor_principal_id, command_id, type, before_state, after_state
  ) values (
    v_event.club_id, v_event.id, v_actor_id, p_command_id, 'schedule', v_before, to_jsonb(v_event)
  );
  perform public.production_record_control_command(
    v_event.club_id, v_actor_id, p_command_id, 'event_schedule', p_event_id,
    v_before, to_jsonb(v_event)
  );
  return to_jsonb(v_event);
end;
$$;

create or replace function public.production_set_event_status_v1(
  p_event_id uuid,
  p_status text,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.production_events%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
begin
  if nullif(btrim(p_command_id), '') is null then raise exception 'COMMAND_ID_REQUIRED'; end if;
  select * into v_event from public.production_events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(v_event.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'eventId', p_event_id, 'status', p_status, 'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_event.club_id, p_command_id, 'event_status', p_event_id
  );
  if v_duplicate is not null then return v_duplicate; end if;

  if v_event.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_event.version; end if;
  if not public.production_event_transition_allowed(v_event.status, p_status) then
    raise exception 'INVALID_EVENT_TRANSITION:%->%', v_event.status, p_status;
  end if;

  v_before := to_jsonb(v_event);
  update public.production_events
  set status = p_status, version = version + 1, updated_at = now()
  where id = p_event_id
  returning * into v_event;

  insert into public.production_event_commands (
    club_id, event_id, actor_principal_id, command_id, type, before_state, after_state
  ) values (
    v_event.club_id, v_event.id, v_actor_id, p_command_id, 'set_status', v_before, to_jsonb(v_event)
  );
  perform public.production_record_control_command(
    v_event.club_id, v_actor_id, p_command_id, 'event_status', p_event_id,
    v_before, to_jsonb(v_event)
  );
  return to_jsonb(v_event);
end;
$$;

create or replace function public.production_set_desired_state_v1(
  p_output_id uuid,
  p_state jsonb,
  p_expected_version int,
  p_command_id text,
  p_operation_kind text,
  p_operation_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_output public.production_outputs%rowtype;
  v_desired public.production_desired_states%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_before jsonb;
  v_validated_desired jsonb;
  v_event_status text;
begin
  if nullif(btrim(p_command_id), '') is null then raise exception 'COMMAND_ID_REQUIRED'; end if;
  if p_operation_kind not in ('start', 'stop', 'reconcile', 'reload', 'take', 'clear') then
    raise exception 'INVALID_OPERATION_KIND';
  end if;

  select * into v_output from public.production_outputs where id = p_output_id for update;
  if not found then raise exception 'OUTPUT_NOT_FOUND'; end if;
  v_actor_id := public.production_require_human_manager(v_output.club_id);
  perform public.production_prepare_command(jsonb_build_object(
    'outputId', p_output_id, 'state', p_state, 'expectedVersion', p_expected_version,
    'operationKind', p_operation_kind, 'operationPayload', p_operation_payload
  ));
  v_duplicate := public.production_existing_control_command(
    v_output.club_id, p_command_id, 'desired_state', p_output_id
  );
  if v_duplicate is not null then return v_duplicate; end if;

  v_validated_desired := public.production_validate_desired_state_v1(
    p_state, v_output.club_id, v_output.event_id, v_output.court_id
  );
  if jsonb_typeof(p_operation_payload) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_operation_payload)) then
    raise exception 'INVALID_OPERATION_PAYLOAD';
  end if;

  select status into v_event_status
  from public.production_events where id = v_output.event_id;
  if not v_output.enabled and v_validated_desired ->> 'lifecycle' in ('preflight', 'running') then
    raise exception 'INVALID_OUTPUT_LIFECYCLE';
  end if;
  if v_validated_desired ->> 'lifecycle' = 'running' and v_event_status <> 'live' then
    raise exception 'INVALID_OUTPUT_LIFECYCLE';
  end if;
  if v_validated_desired ->> 'lifecycle' = 'preflight'
    and v_event_status not in ('scheduled', 'ready', 'live') then
    raise exception 'INVALID_OUTPUT_LIFECYCLE';
  end if;
  if (v_validated_desired ->> 'lifecycle' = 'running'
      and p_operation_kind not in ('start', 'take', 'reload', 'reconcile'))
    or (v_validated_desired ->> 'lifecycle' = 'preflight'
      and p_operation_kind not in ('reload', 'reconcile'))
    or (v_validated_desired ->> 'lifecycle' in ('off', 'stopped')
      and p_operation_kind not in ('stop', 'clear', 'reconcile')) then
    raise exception 'INVALID_OPERATION_FOR_LIFECYCLE';
  end if;

  select * into v_desired
  from public.production_desired_states where output_id = p_output_id for update;
  if found then
    if v_desired.version <> p_expected_version then raise exception 'VERSION_CONFLICT:%', v_desired.version; end if;
    v_before := to_jsonb(v_desired);
    update public.production_desired_states
    set version = version + 1,
        state = v_validated_desired,
        updated_by_principal_id = v_actor_id,
        command_id = p_command_id,
        updated_at = now()
    where output_id = p_output_id
    returning * into v_desired;
  else
    if p_expected_version <> 0 then raise exception 'VERSION_CONFLICT:0'; end if;
    insert into public.production_desired_states (
      output_id, club_id, event_id, version, state, updated_by_principal_id, command_id
    ) values (
      v_output.id, v_output.club_id, v_output.event_id, 1, v_validated_desired,
      v_actor_id, p_command_id
    ) returning * into v_desired;
  end if;

  insert into public.production_operations (
    club_id, event_id, court_id, output_id, command_id, kind, payload,
    before_state, after_state, requested_by_principal_id
  ) values (
    v_output.club_id, v_output.event_id, v_output.court_id, v_output.id, p_command_id,
    p_operation_kind, p_operation_payload, v_before, to_jsonb(v_desired), v_actor_id
  );
  perform public.production_record_control_command(
    v_output.club_id, v_actor_id, p_command_id, 'desired_state', p_output_id,
    v_before, to_jsonb(v_desired)
  );
  return to_jsonb(v_desired);
end;
$$;

create or replace function public.production_report_observed_state_v1(
  p_output_id uuid,
  p_sequence bigint,
  p_health text,
  p_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_output public.production_outputs%rowtype;
  v_observed public.production_observed_states%rowtype;
  v_agent_id uuid;
begin
  if p_sequence < 0 then raise exception 'INVALID_SEQUENCE'; end if;
  if p_health not in ('unknown', 'healthy', 'degraded', 'failed', 'offline') then
    raise exception 'INVALID_HEALTH';
  end if;
  select * into v_output from public.production_outputs where id = p_output_id;
  if not found then raise exception 'OUTPUT_NOT_FOUND'; end if;
  v_agent_id := public.production_require_principal('agent', v_output.club_id);
  if not exists (
    select 1 from public.production_assignments a
    where a.event_id = v_output.event_id
      and a.principal_id = v_agent_id
      and a.role = 'agent'
      and a.active
  ) then raise exception 'FORBIDDEN'; end if;

  insert into public.production_observed_states (
    output_id, agent_principal_id, club_id, event_id, sequence, health, state, reported_at
  ) values (
    v_output.id, v_agent_id, v_output.club_id, v_output.event_id, p_sequence, p_health, p_state, now()
  )
  on conflict (output_id, agent_principal_id) do update set
    sequence = excluded.sequence,
    health = excluded.health,
    state = excluded.state,
    reported_at = excluded.reported_at
  where excluded.sequence > production_observed_states.sequence
  returning * into v_observed;
  if not found then raise exception 'SEQUENCE_CONFLICT'; end if;
  return to_jsonb(v_observed);
end;
$$;

create or replace function public.production_claim_operation_v1(
  p_operation_id uuid,
  p_lease_seconds int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.production_operations%rowtype;
  v_claim public.production_operation_claims%rowtype;
  v_agent_id uuid;
  v_lease_seconds int := least(300, greatest(15, p_lease_seconds));
begin
  select * into v_operation from public.production_operations where id = p_operation_id;
  if not found then raise exception 'OPERATION_NOT_FOUND'; end if;
  v_agent_id := public.production_require_principal('agent', v_operation.club_id);
  if not exists (
    select 1 from public.production_assignments a
    where a.event_id = v_operation.event_id
      and a.principal_id = v_agent_id
      and a.role = 'agent'
      and a.active
  ) then raise exception 'FORBIDDEN'; end if;

  insert into public.production_operation_claims (
    operation_id, agent_principal_id, club_id, status, claimed_at, lease_expires_at
  ) values (
    v_operation.id, v_agent_id, v_operation.club_id, 'claimed', now(),
    now() + make_interval(secs => v_lease_seconds)
  )
  on conflict (operation_id) do update set
    agent_principal_id = excluded.agent_principal_id,
    club_id = excluded.club_id,
    status = 'claimed',
    claimed_at = excluded.claimed_at,
    lease_expires_at = excluded.lease_expires_at,
    result = null,
    completed_at = null
  where production_operation_claims.status = 'claimed'
    and (
      production_operation_claims.agent_principal_id = excluded.agent_principal_id
      or production_operation_claims.lease_expires_at <= now()
    )
  returning * into v_claim;
  if not found then raise exception 'OPERATION_CLAIM_CONFLICT'; end if;
  return to_jsonb(v_claim);
end;
$$;

create or replace function public.production_complete_operation_v1(
  p_operation_id uuid,
  p_status text,
  p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_operation public.production_operations%rowtype;
  v_claim public.production_operation_claims%rowtype;
  v_agent_id uuid;
begin
  if p_status not in ('completed', 'failed')
    or p_result is null
    or jsonb_typeof(p_result) <> 'object'
    or not (p_result ? 'summary' and p_result ? 'retryable')
    or exists (
      select 1 from jsonb_object_keys(p_result) as item(value)
      where value not in ('summary', 'retryable')
    )
    or coalesce(jsonb_typeof(p_result -> 'summary'), '') <> 'string'
    or nullif(btrim(p_result ->> 'summary'), '') is null
    or length(p_result ->> 'summary') > 500
    or coalesce(jsonb_typeof(p_result -> 'retryable'), '') <> 'boolean' then
    raise exception 'INVALID_OPERATION_RESULT';
  end if;

  select * into v_operation from public.production_operations where id = p_operation_id;
  if not found then raise exception 'OPERATION_NOT_FOUND'; end if;
  v_agent_id := public.production_require_principal('agent', v_operation.club_id);

  update public.production_operation_claims
  set status = p_status, result = p_result, completed_at = now()
  where operation_id = p_operation_id
    and agent_principal_id = v_agent_id
    and status = 'claimed'
    and lease_expires_at > now()
  returning * into v_claim;
  if not found then raise exception 'OPERATION_COMPLETION_CONFLICT'; end if;
  return to_jsonb(v_claim);
end;
$$;

create or replace function public.production_device_heartbeat_v1(p_status jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.production_devices%rowtype;
  v_principal_id uuid := public.production_require_principal('device');
begin
  update public.production_devices
  set heartbeat_status = p_status,
      last_heartbeat_at = now(),
      updated_at = now()
  where principal_id = v_principal_id and enabled
  returning * into v_device;
  if not found then raise exception 'DEVICE_NOT_FOUND_OR_DISABLED'; end if;
  return to_jsonb(v_device) - 'secret_ref';
end;
$$;

create or replace function public.production_set_human_role_v1(
  p_principal_id uuid,
  p_role text,
  p_granted boolean,
  p_expected_version int,
  p_command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target public.production_principals%rowtype;
  v_actor_id uuid;
  v_duplicate jsonb;
  v_result jsonb;
begin
  select * into v_target from public.production_principals
  where id = p_principal_id for update;
  if not found or v_target.kind <> 'human' then raise exception 'HUMAN_PRINCIPAL_REQUIRED'; end if;
  v_actor_id := public.production_require_human_admin(v_target.club_id);
  if p_role not in ('operator', 'viewer') then raise exception 'INVALID_HUMAN_ROLE'; end if;
  perform public.production_prepare_command(jsonb_build_object(
    'principalId', p_principal_id, 'role', p_role, 'granted', p_granted,
    'expectedVersion', p_expected_version
  ));
  v_duplicate := public.production_existing_control_command(
    v_target.club_id, p_command_id, 'human_role', p_principal_id
  );
  if v_duplicate is not null then return v_duplicate; end if;
  if v_target.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT:%', v_target.version;
  end if;

  if p_granted then
    insert into public.production_principal_roles (principal_id, club_id, role)
    values (v_target.id, v_target.club_id, p_role) on conflict do nothing;
  else
    delete from public.production_principal_roles
    where principal_id = v_target.id and club_id = v_target.club_id and role = p_role;
  end if;
  update public.production_principals
  set version = version + 1, updated_at = now()
  where id = v_target.id returning * into v_target;
  v_result := jsonb_build_object(
    'principal_id', v_target.id, 'club_id', v_target.club_id,
    'role', p_role, 'granted', p_granted, 'version', v_target.version
  );
  perform public.production_record_control_command(
    v_target.club_id, v_actor_id, p_command_id, 'human_role', v_target.id,
    null, v_result
  );
  return v_result;
end;
$$;

create or replace function public.production_get_assigned_secret_refs_v1(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_agent_id uuid;
  v_club_id uuid;
begin
  select club_id into strict v_club_id from public.production_events where id = p_event_id;
  v_agent_id := public.production_require_principal('agent', v_club_id);
  if not public.production_agent_assigned(p_event_id) then raise exception 'FORBIDDEN'; end if;
  return jsonb_build_object(
    'outputs', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'secretRef', o.secret_ref))
      from public.production_outputs o where o.event_id = p_event_id and o.enabled), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'secretRef', d.secret_ref))
      from public.production_assignments a join public.production_devices d
        on d.principal_id = a.principal_id and d.club_id = a.club_id
      where a.event_id = p_event_id and a.role = 'capture' and a.active and d.enabled), '[]'::jsonb)
  );
end;
$$;

revoke all on public.production_principals from public, anon, authenticated;
revoke all on public.production_principal_roles from public, anon, authenticated;
revoke all on public.production_event_days from public, anon, authenticated;
revoke all on public.production_events from public, anon, authenticated;
revoke all on public.production_assignments from public, anon, authenticated;
revoke all on public.production_devices from public, anon, authenticated;
revoke all on public.production_outputs from public, anon, authenticated;
revoke all on public.production_desired_states from public, anon, authenticated;
revoke all on public.production_observed_states from public, anon, authenticated;
revoke all on public.production_operations from public, anon, authenticated;
revoke all on public.production_operation_claims from public, anon, authenticated;
revoke all on public.production_asset_specs from public, anon, authenticated;
revoke all on public.production_event_commands from public, anon, authenticated;
revoke all on public.production_control_commands from public, anon, authenticated;

grant select on public.production_principals to authenticated;
grant select on public.production_principal_roles to authenticated;
grant select on public.production_event_days to authenticated;
grant select on public.production_events to authenticated;
grant select on public.production_assignments to authenticated;
grant select (id, club_id, principal_id, name, kind, enabled, last_heartbeat_at, heartbeat_status, version, created_at, updated_at) on public.production_devices to authenticated;
grant select (id, club_id, event_id, court_id, name, kind, transport, enabled, version, created_at, updated_at) on public.production_outputs to authenticated;
grant select on public.production_desired_states to authenticated;
grant select on public.production_observed_states to authenticated;
grant select on public.production_operations to authenticated;
grant select on public.production_operation_claims to authenticated;
grant select on public.production_asset_specs to authenticated;
grant select on public.production_event_commands to authenticated;
grant select on public.production_control_commands to authenticated;

revoke all on function public.production_upsert_event_day_v1(uuid, uuid, text, date, text, text, int, text) from public, anon;
revoke all on function public.production_upsert_machine_principal_v1(uuid, uuid, uuid, text, text, boolean, int, text) from public, anon;
revoke all on function public.production_upsert_device_v1(uuid, uuid, text, text, text, boolean, int, text) from public, anon;
revoke all on function public.production_upsert_assignment_v1(uuid, uuid, uuid, text, boolean, int, text) from public, anon;
revoke all on function public.production_upsert_output_v1(uuid, uuid, text, text, text, text, boolean, int, text) from public, anon;
revoke all on function public.production_register_asset_spec_v1(uuid, uuid, text, text, text, text, text, int, int, int, jsonb, int, text) from public, anon;
revoke all on function public.production_schedule_event_v1(uuid, uuid, text, text, timestamptz, timestamptz, int, text) from public, anon;
revoke all on function public.production_set_event_status_v1(uuid, text, int, text) from public, anon;
revoke all on function public.production_set_desired_state_v1(uuid, jsonb, int, text, text, jsonb) from public, anon;
revoke all on function public.production_report_observed_state_v1(uuid, bigint, text, jsonb) from public, anon;
revoke all on function public.production_claim_operation_v1(uuid, int) from public, anon;
revoke all on function public.production_device_heartbeat_v1(jsonb) from public, anon;
revoke all on function public.production_complete_operation_v1(uuid, text, jsonb) from public, anon;
revoke all on function public.production_set_human_role_v1(uuid, text, boolean, int, text) from public, anon;
revoke all on function public.production_get_assigned_secret_refs_v1(uuid) from public, anon;
revoke all on function public.production_prevent_mutation() from public, anon, authenticated;
revoke all on function public.production_sync_human_principal() from public, anon, authenticated;
revoke all on function public.production_validate_principal_role() from public, anon, authenticated;
revoke all on function public.production_validate_assignment() from public, anon, authenticated;
revoke all on function public.production_validate_device() from public, anon, authenticated;
revoke all on function public.production_validate_output_court() from public, anon, authenticated;
revoke all on function public.production_guard_event_lifecycle() from public, anon, authenticated;
revoke all on function public.production_require_principal(text, uuid) from public, anon, authenticated;
revoke all on function public.production_require_human_manager(uuid) from public, anon, authenticated;
revoke all on function public.production_existing_control_command(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.production_record_control_command(uuid, uuid, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.production_validate_desired_state_v1(jsonb, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.production_event_transition_allowed(text, text) from public, anon, authenticated;
revoke all on function public.production_event_day_transition_allowed(text, text) from public, anon, authenticated;
revoke all on function public.production_current_principal_id(uuid) from public, anon, authenticated;
revoke all on function public.production_human_can_read(uuid) from public, anon, authenticated;
revoke all on function public.production_human_can_manage(uuid) from public, anon, authenticated;
revoke all on function public.production_agent_assigned(uuid) from public, anon, authenticated;

grant execute on function public.production_schedule_event_v1(uuid, uuid, text, text, timestamptz, timestamptz, int, text) to authenticated;
grant execute on function public.production_upsert_event_day_v1(uuid, uuid, text, date, text, text, int, text) to authenticated;
grant execute on function public.production_upsert_machine_principal_v1(uuid, uuid, uuid, text, text, boolean, int, text) to authenticated;
grant execute on function public.production_upsert_device_v1(uuid, uuid, text, text, text, boolean, int, text) to authenticated;
grant execute on function public.production_upsert_assignment_v1(uuid, uuid, uuid, text, boolean, int, text) to authenticated;
grant execute on function public.production_upsert_output_v1(uuid, uuid, text, text, text, text, boolean, int, text) to authenticated;
grant execute on function public.production_register_asset_spec_v1(uuid, uuid, text, text, text, text, text, int, int, int, jsonb, int, text) to authenticated;
grant execute on function public.production_set_event_status_v1(uuid, text, int, text) to authenticated;
grant execute on function public.production_set_desired_state_v1(uuid, jsonb, int, text, text, jsonb) to authenticated;
grant execute on function public.production_report_observed_state_v1(uuid, bigint, text, jsonb) to authenticated;
grant execute on function public.production_claim_operation_v1(uuid, int) to authenticated;
grant execute on function public.production_device_heartbeat_v1(jsonb) to authenticated;
grant execute on function public.production_complete_operation_v1(uuid, text, jsonb) to authenticated;
grant execute on function public.production_set_human_role_v1(uuid, text, boolean, int, text) to authenticated;
grant execute on function public.production_get_assigned_secret_refs_v1(uuid) to authenticated;

grant execute on function public.production_current_principal_id(uuid) to authenticated;
grant execute on function public.production_human_can_read(uuid) to authenticated;
grant execute on function public.production_human_can_manage(uuid) to authenticated;
grant execute on function public.production_agent_assigned(uuid) to authenticated;

do $$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'production_%' and p.prosecdef
  loop
    execute format('alter function %s set search_path to pg_catalog, public', v_function.signature);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'production_desired_states'
    ) then alter publication supabase_realtime add table public.production_desired_states; end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'production_observed_states'
    ) then alter publication supabase_realtime add table public.production_observed_states; end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'production_operations'
    ) then alter publication supabase_realtime add table public.production_operations; end if;
  end if;
end $$;
