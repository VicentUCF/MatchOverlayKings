export function buildLedgerBootstrapSql() {
  return String.raw`
begin;
select pg_advisory_xact_lock(hashtextextended('kpl-schema-migrations', 0));
create table if not exists public.kpl_schema_migrations (
  filename text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now()
);
revoke all on public.kpl_schema_migrations from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
commit;`;
}

export function buildRecordMigrationSql(filename, hash) {
  const quoteSqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  return String.raw`insert into public.kpl_schema_migrations (filename, sha256)
values (${quoteSqlLiteral(filename)}, ${quoteSqlLiteral(hash)});`;
}

export function selectUnappliedMigrations(localMigrations, appliedMigrations) {
  return localMigrations.filter((migration) => {
    const appliedHash = appliedMigrations.get(migration.name);
    if (appliedHash === undefined) return true;
    if (appliedHash !== migration.hash) throw new Error(`APPLIED_MIGRATION_CHANGED:${migration.name}`);
    return false;
  });
}
