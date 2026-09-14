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

  it('preserves the bounded server error for an operator recovery path', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'NOT_READY', message: 'Conecta primero YouTube.' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch);

    await expect(adapter.readiness()).resolves.toEqual({ kind: 'error', message: 'Conecta primero YouTube.' });
  });
});
