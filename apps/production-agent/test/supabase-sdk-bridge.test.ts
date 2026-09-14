import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentRuntimeConfigSchema,
  createAuthenticatedSupabaseControlPlane,
  createAuthenticatedSupabaseSdkClient,
} from '../src/index.js';
import { operationRow } from './control-plane-fixtures.js';
import { COURT_IDS, productionEnvironment } from './production-agent-fixture.js';

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
afterEach(() => { vi.unstubAllGlobals(); });

it('uses the publishable key and async agent access token without persisting auth', async () => {
// Given
const requests: Request[] = [];
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
const request = new Request(input, init);
requests.push(request);
return new Response(JSON.stringify([operationRow()]), {
headers: { 'content-type': 'application/json' },
status: 200,
});
});
const environment = productionEnvironment();
const config = LocalAgentRuntimeConfigSchema.parse({
courtIds: COURT_IDS,
maxConcurrentPipelines: 3,
supabaseUrl: environment['KPL_AGENT_SUPABASE_URL'],
supabasePublishableKey: environment['KPL_AGENT_SUPABASE_PUBLISHABLE_KEY'],
agentAccessToken: environment['KPL_AGENT_ACCESS_TOKEN'],
secretRootPath: environment['KPL_AGENT_SECRET_ROOT'],
pollIntervalMs: 1000,
shutdownDeadlineMs: 30_000,
});
const controlPlane = createAuthenticatedSupabaseControlPlane(
createAuthenticatedSupabaseSdkClient(config),
);

// When
await controlPlane.listClaimableOperations(1, new AbortController().signal);

// Then
expect(requests).toHaveLength(1);
expect(requests[0]?.headers.get('apikey')).toBe('publishable-example');
expect(requests[0]?.headers.get('authorization')).toBe('Bearer agent-access-example');
expect(JSON.stringify(config)).not.toContain('agent-access-example');
});

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
