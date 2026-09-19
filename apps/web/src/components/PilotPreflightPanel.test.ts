import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { PilotSession } from '@kpl/production-contracts';
import { PilotPreflightPanel } from './PilotPreflightPanel.js';

const session: PilotSession = {
  id: '11111111-1111-4111-8111-111111111111', courtSlug: 'pista-1', mode: 'simulation',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }, status: 'prepared',
  title: 'Partido', description: '', thumbnailUrl: '/thumbnail.png', broadcastId: null,
  watchUrl: null, youtubeStreamStatus: null, encoder: null, startedAt: null, stoppedAt: null, error: null,
  preflight: {
    id: '22222222-2222-4222-8222-222222222222', status: 'blocked',
    startedAt: '2026-09-19T12:00:00.000Z', finishedAt: '2026-09-19T12:00:10.000Z', validUntil: null, preview: null,
    checks: [{ id: 'encoder', label: 'Codificación del programa', status: 'blocked',
      message: 'El codificador no completó un programa reproducible.', checkedAt: '2026-09-19T12:00:10.000Z' }],
  },
};

function render(current = session, pending = false) {
  return renderToStaticMarkup(createElement(PilotPreflightPanel, {
    session: current, pending, onCheck: vi.fn(), onCancel: vi.fn(), onStart: vi.fn(), loadPreview: vi.fn(),
  }));
}

it('offers starting despite a failed encoder diagnostic and retains the finding', () => {
  const html = render();
  expect(html).toContain('El codificador no completó un programa reproducible.');
  const button = html.match(/<button[^>]*>Emitir de todos modos<\/button>/)?.[0];
  expect(button).toBeDefined();
  expect(button).not.toContain('disabled');
});

it('disables the bypass while an operation is pending', () => {
  expect(render(session, true).match(/<button[^>]*>Emitir de todos modos<\/button>/)?.[0]).toContain('disabled');
});

it('only offers bypass for prepared sessions with finished diagnostics and notices', () => {
  expect(render({ ...session, status: 'live' })).not.toContain('Emitir de todos modos');
  expect(render({ ...session, preflight: null })).not.toContain('Emitir de todos modos');
  expect(render({ ...session, preflight: { ...session.preflight!, status: 'running' } })).not.toContain('Emitir de todos modos');
  expect(render({ ...session, preflight: { ...session.preflight!, status: 'ready', checks: [] } })).not.toContain('Emitir de todos modos');
});
