/* global console, process */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import { buildLedgerBootstrapSql, buildRecordMigrationSql, selectUnappliedMigrations } from './migration-ledger.mjs';

const env = {
  ...loadEnvFile('.env'),
  ...loadEnvFile('.env.local'),
  ...loadEnvFile('scripts/.env'),
  ...loadEnvFile('scripts/.env.local'),
  ...process.env,
};
const SUPABASE_POOLER_REGIONS = [
  'us-east-1',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ca-central-1',
  'sa-east-1',
];
const databaseUrl = env.SUPABASE_DB_URL;

if (!databaseUrl) {
  console.error('Missing SUPABASE_DB_URL.');
  console.error('Use SUPABASE_DB_URL=postgresql://... in .env, or put the Postgres URL as the only line.');
  process.exit(1);
}

const postgresEnv = resolvePostgresEnv(databaseUrl);

const migrationsDir = resolve('supabase/migrations');
const localMigrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((name) => ({
    name,
    hash: createHash('sha256').update(readFileSync(resolve(migrationsDir, name))).digest('hex'),
  }));

if (localMigrations.length === 0) {
  console.error('No migrations found in supabase/migrations.');
  process.exit(1);
}

runPsql(['--command', buildLedgerBootstrapSql()]);
const ledgerResult = runPsql([
  '--tuples-only', '--no-align', '--field-separator', '|',
  '--command', 'select filename, sha256 from public.kpl_schema_migrations order by filename',
], true);
const appliedMigrations = new Map(
  ledgerResult.stdout.trim() === ''
    ? []
    : ledgerResult.stdout.trim().split('\n').map((line) => line.split('|')),
);
const hasExistingSchema = runPsql([
  '--tuples-only', '--quiet', '--command', "select to_regclass('public.clubs') is not null",
], true).stdout.trim() === 't';

if (appliedMigrations.size === 0 && hasExistingSchema) {
  const baselineThrough = env.KPL_MIGRATION_BASELINE_THROUGH;
  if (!baselineThrough || !localMigrations.some((migration) => migration.name === baselineThrough)) {
    console.error('MIGRATION_LEDGER_UNINITIALIZED');
    console.error('Set KPL_MIGRATION_BASELINE_THROUGH to the last migration already applied remotely.');
    process.exit(1);
  }
  for (const migration of localMigrations.filter(({ name }) => name <= baselineThrough)) {
    runPsql([
      '--single-transaction',
      '--command', buildRecordMigrationSql(migration.name, migration.hash),
    ]);
    appliedMigrations.set(migration.name, migration.hash);
  }
}
let migrations;

try {
  migrations = selectUnappliedMigrations(localMigrations, appliedMigrations);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

for (const migration of migrations) {
  console.log(`Applying ${migration.name}`);

  runPsql([
    '--single-transaction',
    '--file', resolve(migrationsDir, migration.name),
    '--command', buildRecordMigrationSql(migration.name, migration.hash),
  ]);
}

console.log('Supabase migrations applied.');

function resolvePostgresEnv(connectionString) {
  const directEnv = toPostgresEnv(connectionString);
  const projectRef = projectRefFromDirectHost(directEnv.PGHOST);

  if (!projectRef || env.SUPABASE_DB_DIRECT === 'true') {
    return directEnv;
  }

  if (canConnect(directEnv)) {
    return directEnv;
  }

  console.log('Direct Supabase database connection is unavailable from this network; trying IPv4 pooler.');

  const explicitPoolerEnv = getExplicitPoolerEnv(directEnv, projectRef);

  if (explicitPoolerEnv) {
    if (!canConnect(explicitPoolerEnv)) {
      console.error('Configured Supabase pooler did not accept a test connection.');
      process.exit(1);
    }

    return explicitPoolerEnv;
  }

  for (const region of SUPABASE_POOLER_REGIONS) {
    const poolerEnv = toSupabasePoolerEnv(directEnv, projectRef, `aws-0-${region}.pooler.supabase.com`);

    if (canConnect(poolerEnv)) {
      console.log(`Using Supabase IPv4 pooler in ${region}.`);
      return poolerEnv;
    }
  }

  console.error('Could not find a working Supabase IPv4 pooler.');
  console.error('Set SUPABASE_POOLER_REGION, SUPABASE_POOLER_HOST, or SUPABASE_DB_DIRECT=true in .env.');
  process.exit(1);
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const entries = {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (isPostgresUrl(trimmed)) {
      entries.SUPABASE_DB_URL ??= trimmed;
      continue;
    }

    const separator = trimmed.indexOf('=');

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');

    if (key) {
      entries[key] = value;
    }
  }

  return entries;
}

function toPostgresEnv(connectionString) {
  let url;

  try {
    url = new URL(connectionString);
  } catch {
    console.error('SUPABASE_DB_URL is not a valid URL.');
    process.exit(1);
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    console.error('SUPABASE_DB_URL must start with postgresql:// or postgres://.');
    process.exit(1);
  }

  const nextEnv = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };

  const sslmode = url.searchParams.get('sslmode');

  if (sslmode) {
    nextEnv.PGSSLMODE = sslmode;
  }

  return nextEnv;
}

function isPostgresUrl(value) {
  return value.startsWith('postgresql://') || value.startsWith('postgres://');
}

function projectRefFromDirectHost(host) {
  return host.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
}

function getExplicitPoolerEnv(directEnv, projectRef) {
  if (env.SUPABASE_POOLER_URL) {
    return toPostgresEnv(env.SUPABASE_POOLER_URL);
  }

  if (env.SUPABASE_POOLER_HOST) {
    return toSupabasePoolerEnv(directEnv, projectRef, env.SUPABASE_POOLER_HOST, env.SUPABASE_POOLER_PORT);
  }

  if (env.SUPABASE_POOLER_REGION) {
    return toSupabasePoolerEnv(
      directEnv,
      projectRef,
      `aws-0-${env.SUPABASE_POOLER_REGION}.pooler.supabase.com`,
      env.SUPABASE_POOLER_PORT,
    );
  }

  return null;
}

function toSupabasePoolerEnv(directEnv, projectRef, host, port = '5432') {
  return {
    ...directEnv,
    PGHOST: host,
    PGPORT: port,
    PGUSER: directEnv.PGUSER.includes('.') ? directEnv.PGUSER : `${directEnv.PGUSER}.${projectRef}`,
  };
}

function canConnect(postgresEnv) {
  const result = spawnSync(
    'psql',
    ['--no-psqlrc', '--tuples-only', '--quiet', '-c', 'select 1'],
    {
      encoding: 'utf8',
      timeout: 8_000,
      env: {
        ...env,
        ...postgresEnv,
        PGSSLMODE: env.PGSSLMODE ?? postgresEnv.PGSSLMODE ?? 'require',
        PGCONNECT_TIMEOUT: env.PGCONNECT_TIMEOUT ?? '5',
      },
    },
  );

  return result.status === 0 && result.stdout.trim() === '1';
}

function runPsql(args, capture = false) {
  const result = spawnSync('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', ...args], {
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {
      ...env,
      ...postgresEnv,
      PGSSLMODE: env.PGSSLMODE ?? postgresEnv.PGSSLMODE ?? 'require',
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}
