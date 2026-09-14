import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildLedgerBootstrapSql, buildRecordMigrationSql, selectUnappliedMigrations } from '../../../scripts/migration-ledger.mjs';

describe('migration ledger', () => {
  it('selects only migrations absent from the remote ledger', () => {
    const local = [{ name: '001.sql', hash: 'aaa' }, { name: '002.sql', hash: 'bbb' }];
    expect(selectUnappliedMigrations(local, new Map([['001.sql', 'aaa']]))).toEqual([local[1]]);
  });

  it('rejects an edited migration that was already applied', () => {
    expect(() => selectUnappliedMigrations([{ name: '001.sql', hash: 'new' }], new Map([['001.sql', 'old']]))).toThrow('APPLIED_MIGRATION_CHANGED:001.sql');
  });

  it('never replays a fully recorded migration set', () => {
    const local = [{ name: '001.sql', hash: 'aaa' }, { name: '002.sql', hash: 'bbb' }];
    expect(selectUnappliedMigrations(local, new Map(local.map(({ name, hash }) => [name, hash])))).toEqual([]);
  });

  it('bootstraps safe function privileges and records inside the transaction', () => {
    expect(buildLedgerBootstrapSql()).toContain('alter default privileges in schema public revoke execute on functions from public');
    expect(buildRecordMigrationSql()).toContain('insert into public.kpl_schema_migrations');
    expect(readFileSync('scripts/apply-supabase-migrations.mjs', 'utf8')).toContain("'--single-transaction'");
  });
});
