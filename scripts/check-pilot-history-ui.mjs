/* global document, innerWidth, console, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const html = `<!doctype html><html lang="es">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Historial</title><body><main id="root"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PilotOperationHistory } from '/src/components/PilotOperationHistory.tsx';
import '/src/styles/global.css';
createRoot(document.getElementById('root')).render(React.createElement(PilotOperationHistory));
</script></body></html>`;
const preparationHtml = `<!doctype html><html lang="es">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preparación recuperable</title><body><main id="root"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProductionPilotWorkspaceView } from '/src/components/ProductionPilotWorkspace.tsx';
import { useProductionPilot } from '/src/hooks/useProductionPilot.ts';
import '/src/styles/global.css';
const success = (value) => ({ kind: 'success', value });
const configuration = { courtSlug: 'pista-1', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
  matchdayNumber: 1, seasonLabel: 'T2', privacyStatus: 'private', scheduledAt: '2099-01-01T12:00:00.000Z', updatedAt: '2026-09-19T12:00:00.000Z' };
const base = { id: '123e4567-e89b-42d3-a456-426614174001', courtSlug: 'pista-1', mode: 'youtube',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }, title: 'Kings vs Lions', description: 'Partido',
  thumbnailUrl: '/fixture-thumbnail', broadcastId: null, watchUrl: null, youtubeStreamStatus: null, encoder: null,
  startedAt: null, stoppedAt: null, error: null };
let session = null;
let finishPreparation;
let finishPreflight;
const checkIds = ['configuration', 'camera', 'profile', 'audio', 'storage', 'cpu', 'memory', 'encoder', 'network', 'bitrate', 'mediamtx', 'overlay', 'authorization', 'destination'];
const labels = ['Partido y equipos', 'Señal de cámara', 'Perfil de vídeo', 'Audio', 'Espacio disponible', 'Carga del equipo', 'Memoria disponible', 'Codificación del programa', 'Red y capacidad de subida', 'Bitrate del programa', 'Servicio de cámaras', 'Marcador del programa', 'Autorización', 'Destino preparado'];
const report = (status) => ({ id: '123e4567-e89b-42d3-a456-426614174009', status,
  startedAt: new Date().toISOString(), finishedAt: status === 'running' ? null : new Date().toISOString(),
  validUntil: status === 'warning' ? new Date(Date.now() + 300000).toISOString() : null, preview: null,
  checks: checkIds.map((id, index) => ({ id, label: labels[index], checkedAt: new Date().toISOString(),
    status: status === 'running' ? 'running' : id === 'storage' && status === 'blocked' ? 'blocked' : 'pass',
    message: id === 'storage' && status === 'blocked' ? 'Quedan menos de 128 MB. Libera espacio y repite esta comprobación.'
      : id === 'network' ? 'Subida estimada a Cloudflare: 40,0 Mbps; se requieren 23,9 Mbps para tres pistas, con audio y 30 % de margen.' : 'Comprobación del programa completada.' })) });
window.fixtureActions = [];
const adapter = {
  localAdminUrl: '/',
  readiness: async () => success({ ffmpeg: { available: true, version: 'test', encoders: [] },
    youtube: { configured: true, authorized: true, authorizationUrl: null }, sources: [base.source], limitations: [] }),
  sessions: async () => success(session ? [session] : []),
  configurations: async () => success([configuration]), teams: async () => success([]), mobileCameras: async () => success([]),
  prepare: async () => {
    window.fixtureActions.push('prepare');
    session = { ...base, status: 'preparing', preparationPending: true };
    return new Promise((resolve) => { finishPreparation = resolve; });
  },
  stop: async () => {
    window.fixtureActions.push('stop');
    finishPreparation?.({ kind: 'error', message: 'Preparación cancelada' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    session = { ...base, status: 'stopped', preparationPending: false };
    return success(session);
  },
  recover: async () => {
    window.fixtureActions.push('recover');
    session = { ...base, status: 'prepared', preparationPending: false };
    return success(session);
  },
  start: async () => { window.fixtureActions.push('start'); return success(session); },
  preflight: async (_id, check) => {
    window.fixtureActions.push(check ? 'check:' + check : 'preflight');
    if (check) { session = { ...session, preflight: report('warning') }; return success(session); }
    session = { ...session, preflight: report('running') };
    return new Promise((resolve) => { finishPreflight = resolve; });
  },
  cancelPreflight: async () => {
    window.fixtureActions.push('cancelPreflight');
    session = { ...session, preflight: report('cancelled') };
    finishPreflight?.(success(session)); return success(session);
  },
  preview: async () => ({ kind: 'error', message: 'No se conserva la vista previa de esta prueba.' }),
};
function Fixture() {
  const pilot = useProductionPilot(adapter);
  window.showPreflight = async (status) => {
    session = { ...base, status: 'prepared', preflight: report(status) }; await pilot.refresh();
  };
  window.failPreparation = async () => {
    session = { ...base, status: 'failed', preparationPending: true, error: 'YouTube no confirmó la respuesta.' };
    await pilot.refresh();
  };
  window.showSignalIssue = async (active) => {
    session = { ...base, status: 'live', preparationPending: false,
      signal: { sampledAt: new Date().toISOString(), checking: false, lastVideoSampleAt: new Date().toISOString(),
        audioExpected: true, measuredFramesPerSecond: 30, measuredSpeed: 1, measuredBitrateKbps: 6100, droppedFrameRatio: 0,
        issues: active ? [{ code: 'frozen_video', since: new Date().toISOString(),
          message: 'La imagen apenas cambia durante al menos 8 s. Comprueba si la cámara está congelada o la escena está inmóvil.' }] : [] },
    };
    await pilot.refresh();
  };
  window.showContinuity = async (exhausted) => {
    session = { ...session, status: exhausted ? 'failed' : 'live',
      continuity: { active: true, attempt: exhausted ? 5 : 1, exhausted,
        reason: exhausted ? 'Comprueba la cámara y pulsa Recuperar emisión.' : 'Se interrumpió la captura. Reintentando la cámara.' } };
    await pilot.refresh();
  };
  window.showOverlayFailure = async (holdingLastFrame) => {
    session = { ...session, status: 'failed', continuity: null,
      overlayHealth: { status: 'failed', attempt: 5, holdingLastFrame,
        lastFrameAt: holdingLastFrame ? new Date().toISOString() : null,
        reason: 'El marcador no se recuperó tras cinco intentos. Pulsa Recuperar emisión.' } };
    await pilot.refresh();
  };
  return React.createElement(ProductionPilotWorkspaceView, { pilot, controlsOnly: true, embedded: true,
    courts: [{ slug: 'pista-1', courtId: 'court-1', name: 'Pista 1', productionEnabled: true, assignment: null }] });
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const operations = [
  {
    id: '123e4567-e89b-42d3-a456-426614174000', courtSlug: 'pista-1', kind: 'prepare',
    status: 'completed', sessionId: '123e4567-e89b-42d3-a456-426614174001',
    matchdayNumber: 1, seasonLabel: 'T2', createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z', message: null,
  },
  {
    id: '123e4567-e89b-42d3-a456-426614174002', courtSlug: 'pista-2', kind: 'start',
    status: 'interrupted', sessionId: '123e4567-e89b-42d3-a456-426614174003',
    matchdayNumber: 1, seasonLabel: 'T2', createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
    message: 'El servicio se reinició antes de confirmar esta operación. Comprueba el estado de la pista antes de actuar.',
  },
];
const incidents = [{
  id: '123e4567-e89b-42d3-a456-426614174004', sessionId: operations[0].sessionId,
  operationId: operations[0].id, courtSlug: 'pista-1', matchdayNumber: 1, seasonLabel: 'T2',
  previousStatus: 'reconnecting', status: 'failed', severity: 'critical',
  createdAt: '2026-09-19T12:01:00.000Z',
  message: 'La fuente dejó de responder. Recupera la emisión desde Mandos.',
}, {
  id: '123e4567-e89b-42d3-a456-426614174008', sessionId: null, operationId: null,
  courtSlug: 'pista-3', matchdayNumber: null, seasonLabel: null, previousStatus: null, status: null,
  category: 'mobile_runtime', mobileSessionId: '123e4567-e89b-42d3-a456-426614174009',
  mobileRuntimeCode: 'exhausted', attempt: 5, resolved: false, severity: 'critical',
  createdAt: '2026-09-19T12:02:00.000Z',
  message: 'El servicio de cámaras no se recuperó tras cinco intentos. Revisa el servicio y pulsa Recuperar emisión; si no hay emisión, renueva el enlace móvil.',
}];

// The fixture mounts the real component; it never authenticates or mutates production.
const server = await createServer({
  root: `${root}/apps/web`,
  server: { host: '127.0.0.1', port: 5198, strictPort: true },
  plugins: [{
    name: 'journal-browser-check',
    configureServer(server) {
      server.middlewares.use('/__journal-check', async (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(await server.transformIndexHtml('/__journal-check', html));
      });
      server.middlewares.use('/__preparation-check', async (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(await server.transformIndexHtml('/__preparation-check', preparationHtml));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  page.setDefaultTimeout(10_000);
  let mode = 'success';
  await page.route('**/api/pilot/incidents', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ incidents: mode === 'empty' ? [] : incidents }),
  }));
  await page.route('**/api/pilot/operations', (route) => route.fulfill({
    status: mode === 'error' ? 503 : 200, contentType: 'application/json',
    body: JSON.stringify(mode === 'error'
      ? { error: { code: 'NOT_READY', message: 'El runtime no responde.' } }
      : { operations: mode === 'empty' ? [] : operations }),
  }));
  await page.goto('http://127.0.0.1:5198/__journal-check');
  await page.getByText('Historial de operaciones', { exact: true }).waitFor();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.getByText('pista-2 · Iniciar emisión · Interrumpida', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px reflow');
  await page.getByLabel('Pista', { exact: true }).selectOption('pista-1');
  assert.equal(await page.getByRole('list', { name: 'Operaciones recientes' }).getByRole('listitem').count(), 1);
  await page.getByText('pista-1 · Crítica', { exact: true }).waitFor();
  await page.getByLabel('Pista', { exact: true }).selectOption('pista-3');
  assert.equal(await page.getByRole('list', { name: 'Operaciones recientes' }).getByRole('listitem').count(), 0);
  await page.getByText('pista-3 · Crítica · Servicio de cámaras', { exact: true }).waitFor();
  assert.equal(await page.getByRole('list', { name: 'Incidencias recientes' }).getByRole('listitem').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'camera-only incident 320px reflow');
  await mkdir(`${root}/output/mejoras`, { recursive: true });
  await page.screenshot({ path: `${root}/output/mejoras/mobile-runtime-history-320.png`, fullPage: true });
  await page.getByLabel('Pista', { exact: true }).selectOption('pista-1');

  mode = 'error';
  await page.getByRole('button', { name: 'Actualizar historial' }).click();
  await page.getByRole('alert').waitFor();
  mode = 'empty';
  await page.getByRole('button', { name: 'Actualizar historial' }).click();
  await page.getByText('Todavía no hay operaciones registradas.').waitFor();
  mode = 'success';
  await page.getByRole('button', { name: 'Actualizar historial' }).click();
  await page.getByText('pista-1 · Preparar emisión · Solicitud completada', { exact: true }).waitFor();

  await mkdir(`${root}/output/mejoras`, { recursive: true });
  await page.screenshot({ path: `${root}/output/mejoras/history-320.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '200% CSS zoom reflow');
  await page.screenshot({ path: `${root}/output/mejoras/history-200-percent.png`, fullPage: true });
  console.log('PASS: keyboard, 320px, court filter, camera incident without broadcast, error, retry, empty state, 200% CSS zoom');

  await page.setViewportSize({ width: 390, height: 844 });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('http://127.0.0.1:5198/__preparation-check');
  await page.getByRole('button', { name: 'Preparar en YouTube' }).click();
  const cancel = page.getByRole('button', { name: 'Cancelar preparación' });
  await cancel.waitFor();
  assert.equal(await cancel.isEnabled(), true, 'cancel remains enabled during pending preparation');
  assert.equal(await page.getByRole('button', { name: 'Emitir', exact: true }).count(), 0);
  await cancel.click();
  await page.getByRole('button', { name: 'Preparar en YouTube' }).waitFor();
  await page.evaluate(() => window.failPreparation());
  await page.getByRole('button', { name: 'Recuperar preparación' }).click();
  await page.getByRole('button', { name: 'Emitir', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureActions), ['prepare', 'stop', 'recover'], 'recovery never auto-starts a broadcast');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'controls mobile reflow');
  await page.screenshot({ path: `${root}/output/mejoras/preparation-recovered.png`, fullPage: true });
  console.log('PASS: preparation polling, cancellation while pending, partial recovery without automatic broadcast, mobile controls');
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await page.getByRole('button', { name: 'Emitir', exact: true }).isEnabled(), true, 'preflight is optional');
  await page.getByRole('button', { name: 'Emitir', exact: true }).click();
  await page.waitForFunction(() => window.fixtureActions.at(-1) === 'start');
  await page.getByRole('button', { name: 'Comprobar programa completo' }).click();
  const cancelCheck = page.getByRole('button', { name: 'Cancelar comprobación' });
  await cancelCheck.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Emitir', exact: true }).isDisabled(), true, 'wait for active capture or cancel it');
  assert.equal(await cancelCheck.isEnabled(), true, 'preflight cancellation works while a mutation is pending');
  await cancelCheck.click();
  await page.getByRole('status').filter({ hasText: 'Comprobación cancelada' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Emitir', exact: true }).isEnabled(), true, 'cancellation does not veto start');
  await page.evaluate(() => window.showPreflight('blocked'));
  assert.equal(await page.getByRole('button', { name: 'Emitir', exact: true }).isEnabled(), true, 'diagnostic failures do not veto start');
  assert.equal(await page.locator('.pilot-preflight > details').evaluate(node => node.open), false, 'results stay collapsed');
  assert.equal(await page.locator('.pilot-preflight').getByRole('listitem').count(), 0, 'no long visible checklist');
  await page.getByRole('button', { name: 'Emitir', exact: true }).click();
  await page.waitForFunction(() => window.fixtureActions.at(-1) === 'start');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'preflight 320px reflow');
  await page.screenshot({ path: `${root}/output/mejoras/preflight-informative-320.png`, fullPage: true });
  await page.getByText('Ver resultados (14)', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.pilot-preflight__check--blocked summary').click();
  const retryDisk = page.getByRole('button', { name: 'Repetir: Espacio disponible', exact: true });
  await retryDisk.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.fixtureActions.at(-1) === 'check:storage');
  const retryNetwork = page.getByRole('button', { name: 'Repetir: Red y capacidad de subida', exact: true });
  if (!await retryNetwork.isVisible()) await page.locator('.pilot-preflight__check summary').filter({ hasText: 'Red y capacidad de subida' }).click();
  await retryNetwork.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.fixtureActions.at(-1) === 'check:network');
  assert.equal(await page.getByText(/hasta 26 MiB/).isVisible(), true, 'upload data budget disclosed');
  await page.evaluate(() => window.showPreflight('stale'));
  assert.equal(await page.getByRole('button', { name: 'Emitir', exact: true }).isEnabled(), true, 'stale checks do not veto start');
  await page.getByRole('button', { name: 'Emitir', exact: true }).click();
  await page.waitForFunction(() => window.fixtureActions.at(-1) === 'start');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded preflight 320px reflow');
  console.log('PASS: optional preflight, start without checks/with failures/stale results, collapsed diagnostics, cancellation, keyboard retry, upload notice and 320px reflow');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => window.showSignalIssue(true));
  const signal = page.getByRole('region', { name: 'Calidad de señal de pista-1' });
  await signal.getByRole('alert').waitFor();
  await page.getByText('Emitiendo · Revisar señal', { exact: true }).waitFor();
  const measurements = signal.getByText('Mediciones recientes de señal');
  await measurements.focus();
  await page.keyboard.press('Enter');
  await signal.getByText('6100 kb/s', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'signal warning 320px reflow');
  await page.screenshot({ path: `${root}/output/mejoras/signal-warning-320.png`, fullPage: true });
  await page.evaluate(() => window.showSignalIssue(false));
  await signal.getByText('Sin avisos detectados en la última comprobación.').waitFor();
  assert.equal(await signal.getByRole('alert').count(), 0);
  console.log('PASS: visible source warning during live output, keyboard measurements, recovery, 320px reflow');
  await page.evaluate(() => window.showContinuity(false));
  await page.getByText('Mostrando continuidad en pista-1', { exact: true }).waitFor();
  await page.getByText('Continuidad · Revisar cámara', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Detener', exact: true }).waitFor();
  await page.evaluate(() => window.showContinuity(true));
  const recoverCamera = page.getByRole('button', { name: 'Recuperar emisión', exact: true });
  await recoverCamera.waitFor();
  await recoverCamera.focus();
  assert.equal(await recoverCamera.evaluate((element) => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'continuity 320px reflow');
  await page.screenshot({ path: `${root}/output/mejoras/continuity-320.png`, fullPage: true });
  console.log('PASS: continuity banner, exhausted camera recovery, stop control and mobile reflow');
  await page.evaluate(() => window.showOverlayFailure(true));
  await page.getByText('Revisar marcador de pista-1', { exact: true }).waitFor();
  await page.getByText('Se conserva la última imagen del marcador mientras continúa el vídeo. El tanteo mostrado puede estar desactualizado.').waitFor();
  await page.getByRole('button', { name: 'Recuperar emisión', exact: true }).focus();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'overlay recovery 320px reflow');
  await page.screenshot({ path: `${root}/output/mejoras/overlay-recovery-320.png`, fullPage: true });
  await page.evaluate(() => window.showOverlayFailure(false));
  await page.getByText('La salida espera a recibir el marcador del partido configurado.').waitFor();
  console.log('PASS: stale overlay warning, recovery control, initial output waiting and mobile reflow');
} finally {
  await browser?.close();
  await server.close();
}
