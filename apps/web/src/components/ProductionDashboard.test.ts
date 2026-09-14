import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PilotState } from '../hooks/useProductionPilot.js';
import { ProductionDashboardView } from './ProductionDashboard.js';

const state: PilotState = {
  kind: 'ready',
  readiness: {
    ffmpeg: { available: true, version: 'ffmpeg test' },
    youtube: { configured: true, authorized: true, authorizationUrl: '/oauth' },
    sources: [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }],
    limitations: [],
  },
  configurations: [{
    courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
    matchdayNumber: 2, seasonLabel: 'T2', scheduledAt: '2026-09-14T18:00:00.000Z', privacyStatus: 'private',
    updatedAt: '2026-09-14T16:00:00.000Z',
  }],
  sessions: [], refreshing: false, pendingCourts: [], courtErrors: {}, error: null,
};

describe('unified production dashboard', () => {
  it('groups stream state and visual overlay access by court', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, { state }));

    expect((html.match(/class="production-dashboard-court"/g) ?? [])).toHaveLength(3);
    expect((html.match(/<iframe/g) ?? [])).toHaveLength(3);
    expect(html).toContain('/overlay/pista-1/scoreboard');
    expect(html).toContain('/control/pista-1');
    expect(html).toContain('Kings');
    expect(html).toContain('Mandos de emisión');
    expect(html).toContain('Control visual');
    expect(html).toContain('Emisión sin configurar');
  });

  it('keeps visual control available when the local streaming agent fails', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { kind: 'error', message: 'Agente desconectado' },
    }));

    expect(html).toContain('Agente desconectado');
    expect(html).toContain('/control/pista-1');
    expect((html.match(/Control visual/g) ?? [])).toHaveLength(3);
  });
});
