begin;

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Required publication supabase_realtime is not enabled locally.';
  end if;

  foreach v_table in array array[
    'production_principals',
    'production_principal_roles',
    'courts',
    'production_assignments',
    'production_events',
    'production_outputs'
  ]
  loop
    if (select count(*) from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = v_table) <> 1 then
      raise exception 'Assertion failed: % must be a member of supabase_realtime exactly once.', v_table;
    end if;
  end loop;
end;
$$;

rollback;
