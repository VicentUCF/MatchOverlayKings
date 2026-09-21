import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PilotSession } from '@kpl/production-contracts';
import type { ProductionPilotController } from '../hooks/useProductionPilot.js';
import type { ProductionCourtSlot } from '../lib/production-overview-types.js';
import { ProductionSetupWizard } from './ProductionSetupWizard.js';

const courts: readonly ProductionCourtSlot[] = [1, 2, 3].map((number) => ({
  slug: `pista-${number}`,
  courtId: `80000000-0000-4000-8000-00000000000${number}`,
  name: `Pista ${number}`,
  productionEnabled: true,
  assignment: null,
}));

const activeSession: PilotSession = {
  id: '11111111-1111-4111-8111-111111111111', courtSlug: 'pista-1', mode: 'recording',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }, status: 'live',
  title: 'Kings vs Lions', description: 'Grabación', thumbnailUrl: '/thumbnail.png',
  broadcastId: null, watchUrl: null, youtubeStreamStatus: null, encoder: null,
  startedAt: '2026-09-21T10:00:00.000Z', stoppedAt: null, error: null,
};

function controller(sessions: readonly PilotSession[] = []): ProductionPilotController {
  return {
    state: {
      kind: 'ready',
      readiness: {
        ffmpeg: { available: true, version: 'ffmpeg test' },
        youtube: { configured: true, authorized: true, authorizationUrl: '/oauth' },
        sources: [
          { id: 'mobile:pilot', kind: 'mobile', label: 'Móvil' },
          { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' },
        ],
        limitations: [],
      },
      teams: [], configurations: [], sessions, mobileCameras: [], mobileConnectUrls: {},
      refreshing: false, pendingCourts: [], courtErrors: {}, error: null,
    },
    localAdminUrl: 'http://127.0.0.1:4310/admin',
    refresh: async () => undefined,
    configure: async () => false,
    createMobileCamera: async () => null,
    updateMobileCamera: async () => false,
    revokeMobileCamera: async () => false,
    prepare: async () => undefined,
    start: async () => undefined,
    preflight: async () => undefined,
    cancelPreflight: async () => undefined,
    preview: async () => ({ kind: 'error', message: 'Sin vista previa' }),
    recover: async () => undefined,
    stop: async () => undefined,
  };
}

describe('guided production setup', () => {
  it('starts by asking which courts will be recorded', () => {
    const html = renderToStaticMarkup(createElement(ProductionSetupWizard, {
      pilot: controller(), courts, kind: 'recording', onBack: () => undefined, onComplete: () => undefined,
    }));

    expect(html).toContain('¿Qué pistas quieres grabar?');
    expect(html).toContain('Grabación local');
    expect(html).toContain('Ajustes para toda la producción');
    expect(html).toContain('Temporada');
    expect(html).toContain('Jornada');
    expect(html).toContain('Carpeta de grabaciones');
    expect(html).toContain('Todos los archivos de esta producción se guardarán aquí.');
    expect((html.match(/type="checkbox"/g) ?? [])).toHaveLength(3);
    expect(html).toContain('Selecciona al menos una pista');
    expect(html).not.toContain('1 Partido');
  });

  it('makes a court with an active session unavailable', () => {
    const html = renderToStaticMarkup(createElement(ProductionSetupWizard, {
      pilot: controller([activeSession]), courts, kind: 'recording', onBack: () => undefined, onComplete: () => undefined,
    }));

    expect(html).toContain('Tiene una sesión activa');
    expect(html).toMatch(/<input type="checkbox" disabled=""/);
  });

  it('uses the same approachable flow for an exceptional real live production', () => {
    const html = renderToStaticMarkup(createElement(ProductionSetupWizard, {
      pilot: controller(), courts, kind: 'youtube', onBack: () => undefined, onComplete: () => undefined,
    }));

    expect(html).toContain('¿Qué pistas quieres emitir?');
    expect(html).toContain('Directo en YouTube');
    expect(html).toContain('Ajustes para toda la producción');
    expect(html).not.toContain('Carpeta de grabaciones');
    expect(html).toContain('Después configuraremos cada pista por separado.');
  });
});
