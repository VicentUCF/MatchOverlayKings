import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PilotMobileCameraSessionSchema, type PilotSession } from '@kpl/production-contracts';
import type { PilotState } from '../hooks/useProductionPilot.js';
import type { ProductionCourtSlot } from '../lib/production-overview-types.js';
import { ProductionDashboardView } from './ProductionDashboard.js';

const state: PilotState = {
  kind: 'ready',
  readiness: {
    ffmpeg: { available: true, version: 'ffmpeg test' },
    youtube: { configured: true, authorized: true, authorizationUrl: '/oauth' },
    sources: [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }],
    limitations: [],
  },
  teams: [
    { id: 'kings-of-favar', name: 'Kings of Favar', shortName: 'Kings', logoUrl: '/logos/kings.png', primaryColor: '#D1007A', secondaryColor: '#0F1115' },
    { id: 'red-lions', name: 'Red Lions', shortName: 'Red Lions', logoUrl: '/logos/red-lions.png', primaryColor: '#E21A23', secondaryColor: '#14151A' },
  ],
  configurations: [{
    courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
    matchdayNumber: 2, seasonLabel: 'T2', scheduledAt: '2026-09-14T18:00:00.000Z', privacyStatus: 'private',
    updatedAt: '2026-09-14T16:00:00.000Z',
  }],
  sessions: [], mobileCameras: [], mobileConnectUrls: {},
  refreshing: false, pendingCourts: [], courtErrors: {}, error: null,
};

const liveYoutubeSession: PilotSession = {
  id: '11111111-1111-4111-8111-111111111111', courtSlug: 'pista-1', mode: 'youtube',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }, status: 'live',
  title: 'Kings vs Lions', description: 'Partido en directo', thumbnailUrl: '/thumbnail.png',
  broadcastId: 'broadcast-1', watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
  youtubeStreamStatus: 'active · good', encoder: null, startedAt: '2026-09-14T18:00:00.000Z',
  stoppedAt: null, error: null,
};

const courts: readonly ProductionCourtSlot[] = [1, 2, 3].map((number) => ({
  slug: `pista-${number}`,
  courtId: `80000000-0000-4000-8000-00000000000${number}`,
  name: `Pista ${number}`,
  productionEnabled: true,
  assignment: null,
}));

describe('unified production dashboard', () => {
  it.each([null, 'pista-1'])('previews camera and its live overlay before broadcasting (selection: %s)', (selectedCourt) => {
    const mobileCamera = PilotMobileCameraSessionSchema.parse({
      id: '20000000-0000-4000-8000-000000000001', courtSlug: 'pista-1',
      state: 'ready', desired: { revision: 1, cameraId: null, profile: '1080p30', audioEnabled: true },
      applied: null, capabilities: null, metrics: null, claimed: true, lastHeartbeatAt: null,
      expiresAt: '2026-09-18T12:00:00.000Z', error: null,
      previewUrl: 'http://127.0.0.1:8889/camera/whep',
    });
    const previewState: PilotState = { ...state, configurations: state.kind === 'ready'
      ? state.configurations.map((config) => ({ ...config, sourceId: 'mobile:pilot' })) : [],
      mobileCameras: [mobileCamera] };
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, { state: previewState, courts, selectedCourt }));
    expect(html).toContain('<video');
    expect(html).toContain('/overlay/pista-1/scoreboard?preview=muted');
    expect(html).not.toContain('/overlay/pista-2/scoreboard');
    expect(html).toContain('Cámara + overlay');
    if (selectedCourt) expect(html).toContain('Escuchar cámara en este PC');
    const revoked = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...previewState, mobileCameras: [{ ...mobileCamera, state: 'revoked' }] }, courts, selectedCourt,
    }));
    expect(revoked).not.toContain('<video');
    expect(revoked).not.toContain('?preview=muted');
    expect(revoked).toContain('Sin vista previa de cámara');
  });

  it('shows the actual encoder and preserves the GPU fallback warning', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...state, sessions: [{ ...liveYoutubeSession,
        videoEncoding: { name: 'libx264', label: 'CPU (x264)', hardware: false, device: null, frameRates: [30, 60] },
        encodingWarning: 'La GPU falló; emisión recuperada con CPU.',
      }] }, courts,
    }));
    expect(html).toContain('CPU (x264)');
    expect(html).toContain('La GPU falló; emisión recuperada con CPU.');
  });

  it('groups stream state and visual overlay access by court', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, { state, courts }));

    expect((html.match(/class="production-dashboard-court"/g) ?? [])).toHaveLength(3);
    expect(html).not.toContain('<iframe');
    expect((html.match(/Marcador del anotador, solo lectura/g) ?? [])).toHaveLength(3);
    expect(html).toContain('data-monitor-court="pista-1"');
    expect(html).toContain('Kings');
    expect(html).toContain('Abrir pista');
    expect(html).toContain('Cámara + overlay');
    expect(html).toContain('Emisión sin configurar');
  });

  it('keeps visual control available when the local streaming agent fails', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { kind: 'error', message: 'Agente desconectado' },
      courts,
      localAdminUrl: 'http://127.0.0.1:4310/admin',
    }));

    expect(html).toContain('Agente desconectado');
    expect(html).toContain('Abrir panel local');
    expect(html).toContain('http://127.0.0.1:4310/admin');
    expect(html).toContain('Datos de emisión sin confirmar');
    expect((html.match(/Marcador del anotador, solo lectura/g) ?? [])).toHaveLength(3);
  });

  it('offers the YouTube live stream from Inicio once broadcasting has started', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...state, sessions: [liveYoutubeSession] },
      courts,
    }));

    expect(html).toContain('Ver directo en YouTube');
    expect(html).toContain('href="https://www.youtube.com/watch?v=broadcast-1"');
    expect(html).toContain('target="_blank"');
  });

  it('surfaces an interrupted broadcast as an incident instead of a finished session', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...state, sessions: [{ ...liveYoutubeSession, status: 'interrupted' }] },
      courts,
    }));

    expect(html).toContain('Interrumpida');
    expect(html).not.toContain('Finalizada');
  });

  it('uses dynamic inventory and keeps disabled courts visible but non-operable', () => {
    const dynamicCourts: readonly ProductionCourtSlot[] = [
      ...courts,
      {
        slug: 'pista-central', courtId: '80000000-0000-4000-8000-000000000004',
        name: 'Pista central', productionEnabled: false, assignment: null,
      },
    ];
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, { state, courts: dynamicCourts }));

    expect((html.match(/class="production-dashboard-court"/g) ?? [])).toHaveLength(4);
    expect(html).toContain('Pista central');
    expect(html).toContain('Producción desactivada');
    expect(html).toContain('Emitiendo</dt><dd>0/3');
  });

  it('does not count starting or stale sessions as confirmed live output', () => {
    const starting = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...state, sessions: [{ ...liveYoutubeSession, status: 'starting' }] }, courts,
    }));
    expect(starting).toContain('Emitiendo</dt><dd>0/3');
    const stale = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...state, error: 'Sin conexión', sessions: [liveYoutubeSession] }, courts,
    }));
    expect(stale).toContain('Emitiendo</dt><dd>—');
    expect(stale).not.toContain('production-status success');
  });

  it('surfaces signal issues on the global dashboard', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { ...state, sessions: [{ ...liveYoutubeSession, encodingWarning: 'La GPU falló; emisión recuperada con CPU.' }] }, courts,
    }));
    expect(html).toContain('Requieren atención');
    expect(html).toContain('Emitiendo · Revisar señal');
    expect(html).toContain('Con incidencias</dt><dd>1');
  });

  it('keeps the individual score monitor available when the streaming runtime is offline', () => {
    const html = renderToStaticMarkup(createElement(ProductionDashboardView, {
      state: { kind: 'error', message: 'Sin conexión' }, courts, selectedCourt: 'pista-2',
    }));
    expect(html).toContain('Vista individual');
    expect(html).toContain('overlay en directo');
    expect(html).toContain('/control/pista-2');
    expect(html).toContain('Marcador del anotador, solo lectura');
    expect(html).toContain('Datos de emisión sin confirmar');
    expect(html).not.toContain('data-monitor-court="pista-1"');
  });
});
