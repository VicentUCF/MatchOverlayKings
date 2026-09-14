do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'production_operation_claims'
    ) then alter publication supabase_realtime add table public.production_operation_claims; end if;
  end if;
end $$;
