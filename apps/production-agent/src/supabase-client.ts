import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ControlPlaneAdapterError } from './control-plane.js';
import type {
  ControlPlaneRequest,
  ControlPlaneRequestExecutor,
  ControlPlaneResponse,
} from './control-plane-request.js';
import { SupabaseControlPlane } from './supabase-control-plane.js';
import type { LocalAgentRuntimeConfig } from './local-runtime-config.js';

export type AuthenticatedSupabaseClient = Pick<SupabaseClient, 'from' | 'rpc'>;

export function createAuthenticatedSupabaseSdkClient(
  config: LocalAgentRuntimeConfig,
): SupabaseClient {
  return config.supabasePublishableKey.use((publishableKey) => createClient(
    config.supabaseUrl,
    publishableKey,
    {
      accessToken: async () => config.agentAccessToken.use((accessToken) => accessToken),
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  ));
}

export function createAuthenticatedSupabaseControlPlane(
  client: AuthenticatedSupabaseClient,
): SupabaseControlPlane {
  const execute: ControlPlaneRequestExecutor = async (request, signal) => {
    const response = await executeRequest(client, request, signal);
    if (response.error === null) return { data: response.data, error: null };
    return {
      data: null,
      error: { code: response.error.code, message: response.error.message },
    };
  };
  return new SupabaseControlPlane(execute);
}

async function executeRequest(
  client: AuthenticatedSupabaseClient,
  request: ControlPlaneRequest,
  signal: AbortSignal,
): Promise<ControlPlaneResponse> {
  switch (request.kind) {
    case 'select': {
      const response = await client.from(request.name).select(request.columns).abortSignal(signal);
      return normalizeResponse(response);
    }
    case 'rpc': {
      const response = await client.rpc(request.name, request.args).abortSignal(signal);
      return normalizeResponse(response);
    }
    default:
      return assertNever(request);
  }
}

function normalizeResponse(response: {
  readonly data: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
}): ControlPlaneResponse {
  if (response.error === null) return { data: response.data, error: null };
  return {
    data: null,
    error: { code: response.error.code, message: response.error.message },
  };
}

function assertNever(value: never): never {
  void value;
  throw new ControlPlaneAdapterError('REQUEST_FAILED');
}
