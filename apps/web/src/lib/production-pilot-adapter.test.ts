import { describe, expect, it, vi } from 'vitest';
import { createProductionPilotAdapter } from './production-pilot-adapter.js';

const readiness = {
  ffmpeg: { available: true, version: 'ffmpeg version test' },
  youtube: { configured: false, authorized: false, authorizationUrl: null },
  sources: [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }],
  limitations: ['YouTube pendiente'],
} as const;

describe('production pilot adapter', () => {
  it('loads and validates readiness from the local agent', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(readiness), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch);

    await expect(adapter.readiness()).resolves.toEqual({ kind: 'success', value: readiness });
    expect(fetcher).toHaveBeenCalledWith('/api/pilot/readiness', undefined);
  });

  it('targets the loopback agent from a deployed web and requests local-network access', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(readiness), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch, 'http://127.0.0.1:4310/');

    await expect(adapter.readiness()).resolves.toEqual({ kind: 'success', value: readiness });
    expect(adapter.localAdminUrl).toBe('http://127.0.0.1:4310/admin');
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:4310/api/pilot/readiness',
      expect.objectContaining({ targetAddressSpace: 'loopback' }),
    );
  });

  it('preserves the bounded server error for an operator recovery path', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'NOT_READY', message: 'Conecta primero YouTube.' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch);

    await expect(adapter.readiness()).resolves.toEqual({ kind: 'error', message: 'Conecta primero YouTube.' });
  });

  it('saves and validates a reusable court configuration', async () => {
    const input = {
      courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Local', awayTeam: 'Visitante',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: '2026-09-14T12:00:00.000Z', privacyStatus: 'private',
    } as const;
    const configuration = { ...input, updatedAt: '2026-09-14T10:00:00.000Z' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ configuration }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch);

    await expect(adapter.configure(input)).resolves.toEqual({ kind: 'success', value: configuration });
    expect(fetcher).toHaveBeenCalledWith('/api/pilot/configurations/pista-1', expect.objectContaining({
      method: 'PUT', body: JSON.stringify(input),
    }));
  });
});
