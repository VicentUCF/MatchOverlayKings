import { describe, expect, it, vi } from 'vitest';
import { SupabaseProductionAccessGuard } from '../src/production-access.js';

describe('production runtime access', () => {
  it.each([
    ['production_admin', 'production_admin'],
    ['production_admin', 'operator'],
    ['operator', 'operator'],
  ] as const)('allows %s to satisfy %s access', async (capability, required) => {
    const fetcher = vi.fn(async () => Response.json(capability));
    const guard = new SupabaseProductionAccessGuard({ url: 'https://db.example/', publishableKey: 'public' }, fetcher);

    await expect(guard.require('Bearer valid-session', required)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      'https://db.example/rest/v1/rpc/production_runtime_capability',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer valid-session', apikey: 'public' }),
      }),
    );
  });

  it('prevents operators from changing administrator-only configuration', async () => {
    const guard = new SupabaseProductionAccessGuard(
      { url: 'https://db.example', publishableKey: 'public' },
      async () => Response.json('operator'),
    );

    await expect(guard.require('Bearer valid-session', 'production_admin'))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('fails closed for missing sessions, rejected roles, malformed responses, and transport errors', async () => {
    const config = { url: 'https://db.example', publishableKey: 'public' };
    await expect(new SupabaseProductionAccessGuard(config).require(undefined, 'operator'))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(new SupabaseProductionAccessGuard(config, async () => Response.json({}, { status: 403 }))
      .require('Bearer denied', 'operator')).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(new SupabaseProductionAccessGuard(config, async () => Response.json('viewer'))
      .require('Bearer viewer', 'operator')).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(new SupabaseProductionAccessGuard(config, async () => { throw new Error('offline'); })
      .require('Bearer valid-session', 'operator')).rejects.toMatchObject({ statusCode: 503, code: 'NOT_READY' });
  });
});
