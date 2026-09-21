import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PilotMobileCameraSessionSchema, type PilotSession } from '@kpl/production-contracts';
import type { ProductionPilotController } from '../hooks/useProductionPilot.js';
import type { ProductionCourtSlot } from '../lib/production-overview-types.js';
import { ProductionTabbedWorkspace } from './ProductionOverview.js';
import { ProductionPilotWorkspaceView } from './ProductionPilotWorkspace.js';

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
  preflight: async () => undefined,
  cancelPreflight: async () => undefined,
  preview: async () => ({ kind: 'error', message: 'Sin vista previa' }),
  recover: async () => undefined,
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

const courts: readonly ProductionCourtSlot[] = [1, 2, 3].map((number) => ({
  slug: `pista-${number}`,
  courtId: `80000000-0000-4000-8000-00000000000${number}`,
  name: `Pista ${number}`,
  productionEnabled: true,
  assignment: null,
}));

describe('tabbed production workspace', () => {
  it('keeps each mobile link in its own court and leaves another mobile source available', () => {
    const mobileCameras = [1, 2].map((number) => PilotMobileCameraSessionSchema.parse({
      id: `20000000-0000-4000-8000-00000000000${number}`, courtSlug: `pista-${number}`,
      state: 'waiting_permission', desired: { revision: 1, cameraId: null, profile: '1080p30', audioEnabled: true },
      applied: null, capabilities: null, metrics: null, claimed: false, lastHeartbeatAt: null,
      expiresAt: '2026-09-18T12:00:00.000Z', error: null, previewUrl: null,
    }));
    const readyPilot: ProductionPilotController = { ...pilot, state: {
      kind: 'ready', readiness: {
        ffmpeg: { available: true, version: 'test' }, youtube: { configured: false, authorized: false, authorizationUrl: null },
        sources: [{ id: 'mobile:pilot', kind: 'mobile', label: 'Puerta de enlace · WebRTC' }], limitations: [],
      }, teams: [], configurations: courts.map(({ slug }) => ({
        courtSlug: slug, sourceId: 'mobile:pilot', mode: 'simulation', homeTeam: 'Kings', awayTeam: 'Lions',
        matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: '2026-09-18T12:00:00.000Z',
        privacyStatus: 'private', updatedAt: '2026-09-17T12:00:00.000Z',
      })), sessions: [], mobileCameras,
      mobileConnectUrls: Object.fromEntries(mobileCameras.map(({ id, courtSlug }) => [id, `https://live.kingspadelleague.es/camera/pilot#${courtSlug}`])),
      refreshing: false, pendingCourts: [], courtErrors: {}, error: null,
    } };
    const html = renderToStaticMarkup(createElement(ProductionPilotWorkspaceView, { pilot: readyPilot, courts }));
    expect(html).toContain('id="mobile-link-pista-1" readOnly="" value="https://live.kingspadelleague.es/camera/pilot#pista-1"');
    expect(html).toContain('id="mobile-link-pista-2" readOnly="" value="https://live.kingspadelleague.es/camera/pilot#pista-2"');
    expect(html).toContain('Puerta de enlace · WebRTC');
    expect(html).not.toContain('Móvil Android');
    expect((html.match(/Generar enlace/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('asignada a');
    expect(html).not.toMatch(/<option[^>]*disabled/);
  });

  it('warns while operating with the last valid Supabase inventory', () => {
    const html = renderToStaticMarkup(createElement(ProductionTabbedWorkspace, {
      initialArea: 'production', pilot, courts, inventoryStale: true, signOut: async () => undefined,
    }));

    expect(html).toContain('Se conserva la última configuración válida');
  });

  it('keeps Producción and Grabaciones as the two shared admin areas', () => {
    const html = renderToStaticMarkup(createElement(ProductionTabbedWorkspace, {
      initialArea: 'production', pilot, courts, signOut: async () => undefined,
    }));

    expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(2);
    expect((html.match(/class="production-workspace-panel"/g) ?? [])).toHaveLength(2);
    expect((html.match(/role="tabpanel"[^>]*hidden=""/g) ?? [])).toHaveLength(1);
    expect(html).toContain('Todas las pistas, en un solo sitio');
    expect(html).toContain('Nueva producción');
    expect(html).not.toContain('Sistema');
  });

  it('offers the active YouTube stream from the production detail', () => {
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
        teams: [
          { id: 'kings-of-favar', name: 'Kings of Favar', shortName: 'Kings', logoUrl: '/logos/kings.png', primaryColor: '#D1007A', secondaryColor: '#0F1115' },
          { id: 'red-lions', name: 'Red Lions', shortName: 'Red Lions', logoUrl: '/logos/red-lions.png', primaryColor: '#E21A23', secondaryColor: '#14151A' },
        ],
        configurations: [{
          courtSlug: 'pista-1', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
          matchdayNumber: 2, seasonLabel: 'T2', description: 'Descripción compartida de la jornada',
          recordingDirectory: '/mnt/grabaciones',
          scheduledAt: '2026-09-14T18:00:00.000Z', privacyStatus: 'public',
          updatedAt: '2026-09-14T16:00:00.000Z',
        }],
        sessions: [liveYoutubeSession], mobileCameras: [], mobileConnectUrls: {},
        refreshing: false, pendingCourts: [], courtErrors: {}, error: null,
      },
    };
    const html = renderToStaticMarkup(createElement(ProductionTabbedWorkspace, {
      initialArea: 'production', pilot: readyPilot, courts, signOut: async () => undefined,
    }));

    expect((html.match(/Ver directo en YouTube/g) ?? [])).toHaveLength(1);
    expect((html.match(/href="https:\/\/www.youtube.com\/watch\?v=broadcast-1"/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('Simulación');
    expect(html).toContain('Nueva producción');
  });

  it('offers recovery and finalization without creating another broadcast', () => {
    const interruptedPilot: ProductionPilotController = {
      ...pilot,
      state: {
        kind: 'ready',
        readiness: {
          ffmpeg: { available: true, version: 'ffmpeg test' },
          youtube: { configured: true, authorized: true, authorizationUrl: '/oauth' },
          sources: [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }],
          limitations: [],
        },
        teams: [],
        configurations: [{
          courtSlug: 'pista-1', mode: 'youtube', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
          matchdayNumber: 2, seasonLabel: 'T2', scheduledAt: '2026-09-14T18:00:00.000Z', privacyStatus: 'private',
          updatedAt: '2026-09-14T16:00:00.000Z',
        }],
        sessions: [{
          ...liveYoutubeSession,
          status: 'interrupted',
          encoder: null,
          error: 'El servicio se reinició durante esta emisión.',
        }],
        mobileCameras: [], mobileConnectUrls: {}, refreshing: false,
        pendingCourts: [], courtErrors: {}, error: null,
      },
    };

    const html = renderToStaticMarkup(createElement(ProductionPilotWorkspaceView, {
      pilot: interruptedPilot, controlsOnly: true, courts,
    }));

    expect(html).toContain('Interrumpida');
    expect(html).toContain('Recuperar emisión');
    expect(html).toContain('Finalizar sesión');
    expect(html).toContain('El servicio se reinició durante esta emisión.');
  });
});
