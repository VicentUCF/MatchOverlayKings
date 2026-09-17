begin;

-- Check the resulting catalog, including future application functions.
do $$
declare
  v_function record;
begin
  for v_function in
    select p.oid, p.proname, p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'kpl\_%' escape '\' or p.proname like 'production\_%' escape '\')
  loop
    if not exists (
      select 1 from unnest(v_function.proconfig) setting
      where setting like 'search_path=%'
    ) then
      raise exception 'Mutable search_path: %', v_function.proname;
    end if;
    if v_function.prosecdef and has_function_privilege('anon', v_function.oid, 'EXECUTE') then
      raise exception 'Anonymous SECURITY DEFINER access: %', v_function.proname;
    end if;
  end loop;
end;
$$;

-- No inherited PUBLIC grants or explicit client grants on new functions.
create function public.kpl_security_default_acl_probe()
returns int language sql set search_path = '' as $$ select 1; $$;

do $$
begin
  if has_function_privilege('anon', 'public.kpl_security_default_acl_probe()', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.kpl_security_default_acl_probe()', 'EXECUTE') then
    raise exception 'New functions must opt in to client execution';
  end if;
end;
$$;

-- Exercise actual calls under each API role. NULL inputs must never reach a body.
create function pg_temp.assert_internal_helpers_denied()
returns void language plpgsql as $$
declare
  v_call text;
begin
  foreach v_call in array array[
    'public.kpl_load_command_context(null::text, null::int, null::text)',
    'public.kpl_require_club_member(null::uuid)',
    'public.kpl_store_state(null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::jsonb, null::jsonb, false)',
    'public.production_prepare_command(null::jsonb)',
    'public.production_require_human_admin(null::uuid)'
  ] loop
    begin
      execute 'select ' || v_call;
      raise exception 'Internal helper callable by %: %', current_user, v_call;
    exception when insufficient_privilege then
      null;
    end;
  end loop;
end;
$$;

-- Test helpers need explicit access after default function privileges are hardened.
grant execute on function pg_temp.assert_internal_helpers_denied() to anon, authenticated;

set local role anon;
select pg_temp.assert_internal_helpers_denied();
reset role;

set local role authenticated;
select pg_temp.assert_internal_helpers_denied();
reset role;

-- A caller-controlled path must not hijack a built-in used by a scoring helper.
create schema kpl_security_shadow;
create function kpl_security_shadow.jsonb_build_object(text, text, text, text)
returns jsonb language sql as $$ select '{"hijacked": true}'::jsonb; $$;
set local search_path = kpl_security_shadow, pg_catalog, public;
do $$
begin
  if public.kpl_empty_lineups() <> '{"home":{"player1":"","player2":""},"away":{"player1":"","player2":""}}'::jsonb then
    raise exception 'Scoring helper inherited the caller search_path';
  end if;
end;
$$;

rollback;
