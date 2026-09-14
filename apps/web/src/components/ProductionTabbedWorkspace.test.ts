import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PilotSession } from '@kpl/production-contracts';
import type { ProductionPilotController } from '../hooks/useProductionPilot.js';
import { ProductionTabbedWorkspace } from './ProductionOverview.js';

const pilot: ProductionPilotController = {
  state: { kind: 'loading' },
  localAdminUrl: 'http://127.0.0.1:4310/admin',
  refresh: async () => undefined,
  configure: async () => false,
  createMobileCamera: async () => null,
  updateMobileCamera: async () => false,
  revokeMobileCamera: async () => false,
  prepare: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

const liveYoutubeSession: PilotSession = {
  id: '11111111-1111-4111-8111-111111111111', courtSlug: 'pista-1', mode: 'youtube',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }, status: 'live',
  title: 'Kings vs Lions', description: 'Partido en directo', thumbnailUrl: '/thumbnail.png',
  broadcastId: 'broadcast-1', watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
  youtubeStreamStatus: 'active · good', encoder: null, startedAt: '2026-09-14T18:00:00.000Z',
  stoppedAt: null, error: null,
};

describe('tabbed production workspace', () => {
  it('keeps Inicio, Emisiones and Mandos mounted with one shared controller', () => {
    const html = renderToStaticMarkup(createElement(ProductionTabbedWorkspace, {
      initialArea: 'dashboard', pilot, signOut: async () => undefined,
    }));

    expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(3);
    expect((html.match(/class="production-workspace-panel"/g) ?? [])).toHaveLength(3);
    expect((html.match(/role="tabpanel"[^>]*hidden=""/g) ?? [])).toHaveLength(2);
    expect(html).toContain('Las tres pistas, en un solo sitio');
    expect(html).toContain('Cargando el centro de emisiones');
    expect(html).not.toContain('Sistema');
  });

  it('offers the active YouTube stream from both Inicio and Mandos', () => {
    const readyPilot: ProductionPilotController = {
      ...pilot,
      state: {
        kind: 'ready',
        readiness: {
          ffmpeg: { available: true, version: 'ffmpeg test' },
          youtube: { configured: true, authorized: true, authorizationUrl: '/oauth' },
          sources: [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }],
          limitations: [],
        },
        configurations: [{
          courtSlug: 'pista-1', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
          matchdayNumber: 2, seasonLabel: 'T2', scheduledAt: '2026-09-14T18:00:00.000Z', privacyStatus: 'public',
          updatedAt: '2026-09-14T16:00:00.000Z',
        }],
        sessions: [liveYoutubeSession], mobileCamera: null, mobileConnectUrl: null,
        refreshing: false, pendingCourts: [], courtErrors: {}, error: null,
      },
    };
    const html = renderToStaticMarkup(createElement(ProductionTabbedWorkspace, {
      initialArea: 'controls', pilot: readyPilot, signOut: async () => undefined,
    }));

    expect((html.match(/Ver directo en YouTube/g) ?? [])).toHaveLength(2);
    expect((html.match(/href="https:\/\/www.youtube.com\/watch\?v=broadcast-1"/g) ?? [])).toHaveLength(2);
  });
});
