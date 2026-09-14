import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { CLUB_ID } from './production-overview-test-fixtures.js';
import { createSupabaseProductionBackend } from './production-supabase-backend.js';

describe('Supabase production backend', () => {
  it('selects only canonical operation claim columns with the club filter', async () => {
    const requestedUrls: string[] = [];
    const fetchRequest = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      requestedUrls.push(input instanceof Request ? input.url : input.toString());
      return new Response('[]', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    const client = createClient('https://production.example.com', 'publishable-key', {
      global: { fetch: fetchRequest },
    });

    await createSupabaseProductionBackend(client).select('production_operation_claims', {
      column: 'club_id',
      value: CLUB_ID,
    });

    const requestedUrl = requestedUrls[0];
    if (requestedUrl === undefined) throw new Error('fetch fixture failed');
    const url = new URL(requestedUrl);
    expect(url.searchParams.get('select')).toBe(
      'operation_id,agent_principal_id,club_id,status,claimed_at,lease_expires_at,result,completed_at',
    );
    expect(url.searchParams.get('club_id')).toBe(`eq.${CLUB_ID}`);
  });
});
