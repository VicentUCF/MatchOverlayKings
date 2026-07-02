/* global console, process */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.SUPABASE_DB_URL;

if (!databaseUrl) {
  console.error('Missing SUPABASE_DB_URL.');
  console.error('Use the Supabase Postgres connection string, not the publishable or secret API key.');
  process.exit(1);
}

const migrationsDir = resolve('supabase/migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (migrations.length === 0) {
  console.error('No migrations found in supabase/migrations.');
  process.exit(1);
}

for (const migration of migrations) {
  console.log(`Applying ${migration}`);

  const result = spawnSync(
    'psql',
    ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--file', resolve(migrationsDir, migration), databaseUrl],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PGSSLMODE: process.env.PGSSLMODE ?? 'require',
      },
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('Supabase migrations applied.');
