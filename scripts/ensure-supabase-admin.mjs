/* global console, process */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.SUPABASE_DB_URL;
const env = {
  ...loadEnvFile('apps/web/.env'),
  ...loadEnvFile('apps/web/.env.local'),
  ...process.env,
};

if (!databaseUrl) {
  console.error('Missing SUPABASE_DB_URL.');
  process.exit(1);
}

if (!env.KPL_E2E_EMAIL || !env.KPL_E2E_PASSWORD) {
  console.error('Missing KPL_E2E_EMAIL or KPL_E2E_PASSWORD.');
  process.exit(1);
}

const sql = String.raw`
\o /dev/null
select set_config('app.kpl_email', :'user_email', false);
select set_config('app.kpl_password', :'user_password', false);
\o

do $$
declare
  v_email text := current_setting('app.kpl_email');
  v_password text := current_setting('app.kpl_password');
  v_user_id uuid;
begin
  if nullif(btrim(v_email), '') is null or nullif(v_password, '') is null then
    raise exception 'KPL_E2E_EMAIL/KPL_E2E_PASSWORD required';
  end if;

  select id into v_user_id
  from auth.users
  where email = v_email
  order by created_at nulls last
  limit 1;

  if v_user_id is null then
    v_user_id := gen_random_uuid();

    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token,
      is_sso_user,
      is_anonymous
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object(),
      now(),
      now(),
      '',
      '',
      '',
      '',
      false,
      false
    );
  else
    update auth.users
    set
      encrypted_password = crypt(v_password, gen_salt('bf')),
      aud = 'authenticated',
      role = 'authenticated',
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      raw_app_meta_data = jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      deleted_at = null,
      updated_at = now()
    where id = v_user_id;
  end if;

  insert into auth.identities (
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  )
  values (
    v_user_id::text,
    v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
    'email',
    now(),
    now(),
    now()
  )
  on conflict (provider_id, provider) do update set
    identity_data = excluded.identity_data,
    updated_at = now();

  insert into public.club_users (club_id, user_id, role)
  select id, v_user_id, 'admin'
  from public.clubs
  where slug = 'kpl'
  on conflict do nothing;
end $$;
`;

const result = spawnSync(
  'psql',
  [
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
    '--set',
    `user_email=${env.KPL_E2E_EMAIL}`,
    '--set',
    `user_password=${env.KPL_E2E_PASSWORD}`,
    databaseUrl,
  ],
  {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PGSSLMODE: process.env.PGSSLMODE ?? 'require',
    },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('Supabase admin user ensured.');

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [
          line.slice(0, index).trim(),
          line.slice(index + 1).trim().replace(/^['"]|['"]$/g, ''),
        ];
      }),
  );
}
