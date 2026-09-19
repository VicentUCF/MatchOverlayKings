/* global window, console */
import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../apps/web', import.meta.url));
const fixtureData = `
export const fetchTeams = async () => [];
export const fetchEventSummaries = async () => [];
export const fetchMatchState = async () => {
  if (window.dataOffline) throw new Error('Datos desconectados');
  return { id: 'pista-1', version: window.scoreVersion ?? 1, homeTeamId: 'kings', awayTeamId: 'lions' };
};
export const subscribeToMatchState = (_court, callback) => {
  window.deliverScore = callback; return () => { window.deliverScore = undefined; };
};`;
const html = `<!doctype html><html><body><main id="root"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useMatchSocket } from '/src/hooks/useMatchSocket.ts';
function Fixture() {
  const match = useMatchSocket('pista-1', 'overlay', '');
  return React.createElement('output', { id: 'observed', 'data-connection': match.connectionState,
    'data-confirmed': match.confirmedAt, 'data-version': match.state?.version }, match.error ?? 'Conectado');
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5199, strictPort: true },
  plugins: [{ name: 'overlay-data-fixture', enforce: 'pre',
    load(id) { if (id.endsWith('/src/lib/kpl-data.ts')) return fixtureData; },
    configureServer(server) { server.middlewares.use('/__overlay-data', async (_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(await server.transformIndexHtml('/__overlay-data', html));
    }); },
  }],
});
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // Only the local Vite fixture may receive requests; no Supabase account is used.
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:5199/__overlay-data');
  await page.waitForSelector('#observed[data-connection="connected"][data-version="1"]');
  const first = await page.locator('#observed').getAttribute('data-confirmed');
  assert.ok(Number(first) > 0);
  await page.evaluate(() => { window.dataOffline = true; });
  await page.waitForSelector('#observed[data-connection="error"]', { timeout: 7_000 });
  assert.equal(await page.locator('#observed').getAttribute('data-version'), '1', 'retains the last valid score');
  assert.equal(await page.locator('#observed').getAttribute('data-confirmed'), first, 'failed refresh does not pretend to confirm data');
  await page.evaluate(() => { window.dataOffline = false; window.scoreVersion = 2; });
  await page.waitForSelector('#observed[data-connection="connected"][data-version="2"]', { timeout: 7_000 });
  assert.ok(Number(await page.locator('#observed').getAttribute('data-confirmed')) > Number(first));
  await page.evaluate(() => window.deliverScore({ id: 'pista-1', version: 3, homeTeamId: 'kings', awayTeamId: 'lions' }));
  await page.waitForSelector('#observed[data-version="3"]');
  const confirmed = await page.locator('#observed').getAttribute('data-confirmed');
  await page.waitForTimeout(5_500);
  assert.equal(await page.locator('#observed').getAttribute('data-version'), '3', 'a delayed poll cannot roll back the score');
  assert.equal(await page.locator('#observed').getAttribute('data-confirmed'), confirmed, 'an older snapshot does not confirm freshness');
  console.log('PASS: real React hook retains score offline, exposes stale data, confirms refresh and preserves newer realtime versions');
} finally { await browser?.close(); await server.close(); }
