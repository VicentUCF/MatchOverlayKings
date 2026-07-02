/* global console, fetch, process, URL */
import { existsSync, readFileSync } from 'node:fs';

const env = {
  ...loadEnvFile('apps/web/.env'),
  ...loadEnvFile('apps/web/.env.local'),
  ...process.env,
};

const supabaseUrl = env.VITE_SUPABASE_URL;
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !publishableKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.');
  process.exit(1);
}

const origin = new URL(supabaseUrl).origin;

await checkPublicTable('/rest/v1/teams?select=id&limit=1', 'teams');
await checkPublicTable('/rest/v1/score_states?select=court_slug,status&limit=1', 'score_states');

if (env.KPL_E2E_EMAIL && env.KPL_E2E_PASSWORD) {
  await checkAuthenticatedAdmin();
} else {
  console.log('Skipping authenticated check: KPL_E2E_EMAIL/KPL_E2E_PASSWORD are not set.');
}

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

async function checkPublicTable(path, label) {
  const response = await fetch(`${origin}${path}`, {
    headers: publicHeaders(),
  });
  const payload = await safeJson(response);

  if (!response.ok) {
    console.error(`${label}: ${response.status}`, payload);
    process.exitCode = 1;
    return;
  }

  console.log(`${label}: ok`);
}

async function checkAuthenticatedAdmin() {
  const tokenResponse = await fetch(`${origin}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      ...publicHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: env.KPL_E2E_EMAIL,
      password: env.KPL_E2E_PASSWORD,
    }),
  });
  const tokenPayload = await safeJson(tokenResponse);

  if (!tokenResponse.ok) {
    console.error('auth: failed', tokenResponse.status, tokenPayload);
    process.exitCode = 1;
    return;
  }

  const accessToken = tokenPayload.access_token;
  const claimResponse = await fetch(`${origin}/rest/v1/rpc/claim_default_club`, {
    method: 'POST',
    headers: {
      ...publicHeaders(accessToken),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const claimPayload = await safeJson(claimResponse);

  if (!claimResponse.ok) {
    console.error('claim_default_club: failed', claimResponse.status, claimPayload);
    process.exitCode = 1;
    return;
  }

  const adminStatesResponse = await fetch(`${origin}/rest/v1/score_states?select=court_slug,status,version&order=court_slug`, {
    headers: publicHeaders(accessToken),
  });
  const adminStatesPayload = await safeJson(adminStatesResponse);

  if (!adminStatesResponse.ok) {
    console.error('authenticated score_states: failed', adminStatesResponse.status, adminStatesPayload);
    process.exitCode = 1;
    return;
  }

  console.log(`authenticated admin: ok (${adminStatesPayload.length} courts)`);
}

function publicHeaders(accessToken = publishableKey) {
  return {
    apikey: publishableKey,
    authorization: `Bearer ${accessToken}`,
  };
}

async function safeJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}
