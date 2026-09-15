begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000009997',
  'authenticated', 'authenticated', 'runtime-access-test@example.com', 'not-used', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do nothing;

insert into public.club_users (club_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000009997',
  'admin'
)
on conflict (club_id, user_id) do update set role = excluded.role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009997', true);

do $$
begin
  if public.production_runtime_capability() is distinct from 'production_admin' then
    raise exception 'Assertion failed: club admin must resolve production_admin';
  end if;
end;
$$;

reset role;
update public.club_users
set role = 'member'
where club_id = '00000000-0000-4000-8000-000000000001'
  and user_id = '00000000-0000-4000-8000-000000009997';
insert into public.production_principal_roles (principal_id, club_id, role)
select id, club_id, 'operator'
from public.production_principals
where auth_user_id = '00000000-0000-4000-8000-000000009997';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009997', true);

do $$
begin
  if public.production_runtime_capability() is distinct from 'operator' then
    raise exception 'Assertion failed: operator role must resolve operator';
  end if;
end;
$$;

reset role;
delete from public.production_principal_roles
where principal_id = (
  select id from public.production_principals
  where auth_user_id = '00000000-0000-4000-8000-000000009997'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009997', true);

do $$
begin
  begin
    perform public.production_runtime_capability();
    raise exception 'Assertion failed: viewer-less principal must be forbidden';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

rollback;
