begin;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Required publication supabase_realtime is not enabled locally.';
  end if;
end;
$$;

do $$
begin
  if (select count(*) from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'production_operation_claims') <> 1 then
    raise exception 'Assertion failed: production_operation_claims must be a member of supabase_realtime exactly once.';
  end if;
end;
$$;

rollback;
