import { describe, expect, it, vi } from 'vitest';
import { PilotMobileCameraSessionSchema } from '@kpl/production-contracts';
import { createProductionPilotAdapter } from './production-pilot-adapter.js';

const readiness = {
  ffmpeg: { available: true, version: 'ffmpeg version test' },
  youtube: { configured: false, authorized: false, authorizationUrl: null },
  sources: [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }],
  limitations: ['YouTube pendiente'],
} as const;

const session = {
  id: '123e4567-e89b-42d3-a456-426614174000', courtSlug: 'pista-1', mode: 'youtube',
  source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' }, status: 'prepared',
  title: 'Kings vs Lions', description: 'Partido en directo',
  thumbnailUrl: '/api/pilot/sessions/123e4567-e89b-42d3-a456-426614174000/thumbnail',
  broadcastId: 'broadcast-1', watchUrl: 'https://youtube.com/watch?v=broadcast-1',
  youtubeStreamStatus: 'ready', encoder: null, startedAt: null, stoppedAt: null, error: null,
} as const;

describe('production pilot adapter', () => {
  it('allows a fresh local check after restart instead of reusing an interrupted preflight forever', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'OPERATION_INTERRUPTED', message: 'Reinicio' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ session }));
    const adapter = createProductionPilotAdapter(fetcher);
    expect((await adapter.preflight(session.id)).kind).toBe('error');
    expect((await adapter.preflight(session.id)).kind).toBe('success');
    const keys = fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('loads a private preview as a blob with no-store and refuses external or unrelated URLs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('preview', { headers: { 'content-type': 'video/mp4' } }));
    const adapter = createProductionPilotAdapter(fetcher, 'http://127.0.0.1:4310');
    const path = `/api/pilot/sessions/${session.id}/preflight-preview/${session.id}`;
    const result = await adapter.preview(path, new AbortController().signal);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(await result.value.text()).toBe('preview');
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:4310${path}`, expect.objectContaining({ cache: 'no-store', targetAddressSpace: 'loopback' }));
    expect((await adapter.preview('https://outside.example/preview', new AbortController().signal)).kind).toBe('error');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('journals a partial preflight retry separately from starting a broadcast', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ session }));
    const adapter = createProductionPilotAdapter(fetcher);
    await adapter.preflight(session.id, 'storage');
    expect(fetcher).toHaveBeenCalledWith(`/api/pilot/sessions/${session.id}/preflight`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ check: 'storage' }), headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
    }));
  });
  it('reuses the same operation identifier after a lost response and clears it after success', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(new Response(JSON.stringify({ session }), { status: 200 }));
    const adapter = createProductionPilotAdapter(fetcher);
    expect((await adapter.start(session.id)).kind).toBe('error');
    expect((await adapter.start(session.id)).kind).toBe('success');
    const first = new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Idempotency-Key');
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Idempotency-Key')).toBe(first);
    await adapter.start(session.id);
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('Idempotency-Key')).not.toBe(first);
  });

  it('keeps the operation identifier when the runtime reports an uncertain interruption', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      error: { code: 'OPERATION_INTERRUPTED', message: 'Comprueba la pista.' },
    }), { status: 409 }));
    const adapter = createProductionPilotAdapter(fetcher);
    await adapter.start(session.id);
    await adapter.start(session.id);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Idempotency-Key'))
      .toBe(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Idempotency-Key'));
  });

  it('loads all court cameras through the local agent without collapsing them into one', async () => {
    const mobileCameras = [1, 2].map((n) => PilotMobileCameraSessionSchema.parse({
      id: `20000000-0000-4000-8000-00000000000${n}`, courtSlug: `pista-${n}`, state: 'waiting_permission',
      desired: { revision: 1, cameraId: null, profile: '1080p30', audioEnabled: true },
      applied: null, capabilities: null, metrics: null, claimed: false, lastHeartbeatAt: null,
      expiresAt: '2026-09-18T12:00:00.000Z', error: null, previewUrl: null,
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ mobileCameras }), { status: 200 }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch, 'http://127.0.0.1:4310');
    await expect(adapter.mobileCameras()).resolves.toEqual({ kind: 'success', value: mobileCameras });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/pilot/mobile-cameras',
      expect.objectContaining({ targetAddressSpace: 'loopback' }));
  });

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

  it('loads the team catalogue used by the broadcast selectors', async () => {
    const teams = [{
      id: 'kings-of-favar', name: 'Kings of Favar', shortName: 'Kings', logoUrl: '/logos/kings.png',
      primaryColor: '#D1007A', secondaryColor: '#0F1115',
    }];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ teams }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch);

    await expect(adapter.teams()).resolves.toEqual({ kind: 'success', value: teams });
    expect(fetcher).toHaveBeenCalledWith('/api/teams', undefined);
  });

  it('loads session thumbnails from the loopback agent when the web is deployed', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ sessions: [session] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch, 'http://127.0.0.1:4310/');

    const result = await adapter.sessions();

    expect(result).toMatchObject({
      kind: 'success',
      value: [{
        thumbnailUrl: 'http://127.0.0.1:4310/api/pilot/sessions/123e4567-e89b-42d3-a456-426614174000/thumbnail',
      }],
    });
  });

  it('requests recovery without preparing a second session', async () => {
    const interrupted = {
      ...session,
      status: 'interrupted' as const,
      error: 'El servicio se reinició durante esta emisión.',
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ session: interrupted }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const adapter = createProductionPilotAdapter(fetcher as typeof fetch);

    await expect(adapter.recover(session.id)).resolves.toEqual({ kind: 'success', value: interrupted });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/pilot/sessions/${session.id}/recover`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
