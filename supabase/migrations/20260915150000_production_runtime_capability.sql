create or replace function public.production_runtime_capability()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_capability text;
begin
  select case
    when bool_or(r.role = 'production_admin') then 'production_admin'
    when bool_or(r.role = 'operator') then 'operator'
    else null
  end
  into v_capability
  from public.production_principals p
  join public.production_principal_roles r
    on r.principal_id = p.id and r.club_id = p.club_id
  where p.auth_user_id = auth.uid()
    and p.kind = 'human'
    and p.active
    and r.role in ('production_admin', 'operator');

  if v_capability is null then
    raise insufficient_privilege using message = 'PRODUCTION_RUNTIME_FORBIDDEN';
  end if;
  return v_capability;
end;
$$;

revoke all on function public.production_runtime_capability() from public, anon;
grant execute on function public.production_runtime_capability() to authenticated;
