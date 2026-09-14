import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createAuthenticatedSupabaseControlPlane } from '../src/index.js';
import { operationRow } from './control-plane-fixtures.js';

type GeneratedDatabase = {
  readonly public: {
    readonly Tables: Record<string, never>;
    readonly Views: Record<string, never>;
    readonly Functions: {
      readonly production_list_claimable_operations_v1: {
        readonly Args: { readonly p_limit: number };
        readonly Returns: readonly unknown[];
      };
    };
    readonly Enums: Record<string, never>;
    readonly CompositeTypes: Record<string, never>;
  };
};

describe('Supabase SDK bridge', () => {
  it('accepts the real default SDK client and executes through its no-network builder', async () => {
    const requestedUrls: string[] = [];
    const client = createClient('http://supabase.invalid', 'test-publishable-key', {
      global: {
        fetch: async (input) => {
          requestedUrls.push(String(input));
          return new Response(JSON.stringify([operationRow()]), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        },
      },
    });
    const controlPlane = createAuthenticatedSupabaseControlPlane(client);

    const operations = await controlPlane.listClaimableOperations(
      1,
      new AbortController().signal,
    );

    expect(operations[0]?.commandId).toBe('agent-operation-1');
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('/rest/v1/rpc/production_list_claimable_operations_v1');
  });

  it('accepts an SDK client parameterized by a generated database schema', () => {
    const client = createClient<GeneratedDatabase>(
      'http://supabase.invalid',
      'test-publishable-key',
      { global: { fetch: async () => new Response('[]', { status: 200 }) } },
    );

    const controlPlane = createAuthenticatedSupabaseControlPlane(client);

    expect(controlPlane).toBeDefined();
  });
});
