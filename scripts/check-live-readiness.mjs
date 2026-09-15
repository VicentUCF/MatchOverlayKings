/* global AbortSignal, URL, fetch, process */

const baseUrl = normalizeBaseUrl(process.env.KPL_SMOKE_AGENT_URL ?? 'http://127.0.0.1:4310');
const requireYouTube = enabled(process.env.KPL_SMOKE_REQUIRE_YOUTUBE);
const requireMobile = enabled(process.env.KPL_SMOKE_REQUIRE_MOBILE);

const checks = [];
const warnings = [];

try {
  const [health, ready, readiness, sessionEnvelope] = await Promise.all([
    readJson('/health'),
    readJson('/ready'),
    readJson('/api/pilot/readiness'),
    readJson('/api/pilot/sessions'),
  ]);

  check(health.ok === true, 'El proceso local responde');
  check(ready.ok === true, 'El runtime declara disponibilidad');
  check(readiness.ffmpeg?.available === true, 'FFmpeg está disponible');

  if (requireYouTube) {
    check(readiness.youtube?.configured === true, 'YouTube está configurado');
    check(readiness.youtube?.authorized === true, 'YouTube está autorizado');
  } else if (readiness.youtube?.authorized !== true) {
    warnings.push('YouTube no está autorizado. Usa KPL_SMOKE_REQUIRE_YOUTUBE=true para convertirlo en bloqueo.');
  }

  const sources = Array.isArray(readiness.sources) ? readiness.sources : [];
  if (requireMobile) {
    check(sources.some((source) => source?.kind === 'mobile'), 'La fuente Android está disponible');
  }

  const sessions = Array.isArray(sessionEnvelope.sessions) ? sessionEnvelope.sessions : [];
  const incidents = sessions.filter((session) => session?.status === 'interrupted' || session?.status === 'failed');
  check(incidents.length === 0, 'No hay sesiones interrumpidas o fallidas pendientes');
  for (const session of incidents) {
    warnings.push(`${session.courtSlug ?? 'Pista desconocida'}: ${session.status} · ${session.error ?? 'sin diagnóstico'}`);
  }

  for (const session of sessions) {
    if (session?.status !== 'live' || session.encoder === null || typeof session.encoder !== 'object') continue;
    const speed = Number(session.encoder.speed);
    if (Number.isFinite(speed) && speed < 0.95) {
      warnings.push(`${session.courtSlug}: velocidad ${speed.toFixed(2)}x, por debajo del objetivo 0.95x.`);
    }
  }

  for (const limitation of Array.isArray(readiness.limitations) ? readiness.limitations : []) {
    warnings.push(String(limitation));
  }
} catch (error) {
  checks.push({ ok: false, label: error instanceof Error ? error.message : 'No se pudo comprobar el runtime local' });
}

for (const item of checks) {
  process.stdout.write(`${item.ok ? 'OK' : 'ERROR'} · ${item.label}\n`);
}
for (const warning of [...new Set(warnings)]) {
  process.stdout.write(`AVISO · ${warning}\n`);
}

if (checks.some(({ ok }) => !ok)) process.exitCode = 1;

function check(ok, label) {
  checks.push({ ok, label });
}

async function readJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null || typeof payload !== 'object') {
    throw new Error(`${path} respondió con HTTP ${response.status}`);
  }
  return payload;
}

function enabled(value) {
  return value === '1' || value?.toLowerCase() === 'true';
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('KPL_SMOKE_AGENT_URL no es una URL HTTP válida');
  return url.origin;
}
