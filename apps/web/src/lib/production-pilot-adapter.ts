import { z } from 'zod';
import { supabase } from './supabase.js';
import { createCommandId } from '../command-id.js';
import type { Team } from '@kpl/shared';
import {
  PilotConfigurationSchema,
  PilotOperationSchema,
  PilotIncidentSchema,
  PilotConfigurationsSchema,
  PilotReadinessSchema,
  PilotMobileCameraLinkSchema,
  PilotMobileCameraSessionSchema,
  PilotSessionSchema,
  PilotSessionsSchema,
  PreparePilotSessionInputSchema,
  PublicationJobSchema,
  PublicationJobsSchema,
  RecordingAssetsSchema,
  type PilotConfiguration,
  type PilotCourtSlug,
  type PilotMobileCameraSession,
  type PilotSession,
  type PilotPreflightCheckId,
  type PreparePilotSessionInput,
  type UpdatePilotMobileCameraDesiredInput,
} from '@kpl/production-contracts';

const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
const SessionEnvelopeSchema = z.strictObject({ session: PilotSessionSchema });
const SessionsEnvelopeSchema = z.strictObject({ sessions: PilotSessionsSchema });
const ConfigurationEnvelopeSchema = z.strictObject({ configuration: PilotConfigurationSchema });
const ConfigurationsEnvelopeSchema = z.strictObject({ configurations: PilotConfigurationsSchema });
const MobileCameraEnvelopeSchema = z.strictObject({ mobileCamera: PilotMobileCameraSessionSchema.nullable() });
const MobileCamerasEnvelopeSchema = z.strictObject({ mobileCameras: z.array(PilotMobileCameraSessionSchema) });
const TeamSchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), shortName: z.string().min(1),
  logoUrl: z.string(), primaryColor: z.string(), secondaryColor: z.string(),
});
const TeamsEnvelopeSchema = z.strictObject({ teams: z.array(TeamSchema).readonly() });
const RecordingsEnvelopeSchema = z.strictObject({ assets: RecordingAssetsSchema, jobs: PublicationJobsSchema });
const PublicationEnvelopeSchema = z.strictObject({ job: PublicationJobSchema });

export type PilotApiResult<Value> =
  | { readonly kind: 'success'; readonly value: Value }
  | { readonly kind: 'error'; readonly message: string };

export type ProductionPilotAdapter = ReturnType<typeof createProductionPilotAdapter>;

type LocalNetworkRequestInit = RequestInit & {
  readonly targetAddressSpace?: 'loopback';
};

export function createProductionPilotAdapter(
  fetcher: typeof fetch = fetch,
  localAgentBaseUrl = defaultLocalAgentBaseUrl(),
) {
  const baseUrl = normalizeBaseUrl(localAgentBaseUrl);
  const pendingOperations = new Map<string, string>();
  const request = async <Value>(
    path: string,
    schema: z.ZodType<Value>,
    init?: RequestInit,
  ): Promise<PilotApiResult<Value>> => {
    const journaled = (init?.method === 'POST' || init?.method === 'PUT')
      && (/^\/api\/pilot\/sessions(?:\/[^/]+\/(?:start|stop|recover|preflight))?$/.test(path)
        || path.startsWith('/api/pilot/configurations/'));
    let storageKey: string | null = null;
    const clearOperation = () => {
      if (storageKey === null) return;
      pendingOperations.delete(storageKey);
      try { globalThis.sessionStorage?.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
    };
    try {
      const endpoint = `${baseUrl}${path}`;
      if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'DELETE'
        || path === '/api/pilot/operations' || path === '/api/pilot/incidents'
        || path === '/api/pilot/recordings') {
        const { data } = await supabase.auth.getSession();
        if (journaled) {
          storageKey = `kpl:operation:${baseUrl}:${data.session?.user.id ?? 'local'}:${path}:${String(init?.body ?? '')}`;
          let id = pendingOperations.get(storageKey);
          try { id ??= globalThis.sessionStorage?.getItem(storageKey) ?? undefined; } catch { /* In-memory fallback. */ }
          id ??= createCommandId();
          pendingOperations.set(storageKey, id);
          try { globalThis.sessionStorage?.setItem(storageKey, id); } catch { /* In-memory fallback. */ }
          init = { ...init, headers: { ...init?.headers, 'Idempotency-Key': id } };
        }
        if (data.session) init = { ...init, headers: { ...init?.headers, Authorization: `Bearer ${data.session.access_token}` } };
      }
      const requestInit: LocalNetworkRequestInit | undefined = isLoopbackHttp(baseUrl)
        ? { ...init, targetAddressSpace: 'loopback' }
        : init;
      const response = await fetcher(endpoint, requestInit);
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = ErrorEnvelopeSchema.safeParse(payload);
        if (error.success && error.data.error.code === 'OPERATION_INTERRUPTED' && path.endsWith('/preflight')) {
          // A new local check is safe after restart; do not trap the operator on
          // an interrupted receipt that can never become a valid measurement.
          clearOperation();
          return { kind: 'error', message: 'La comprobación se interrumpió al reiniciar. Vuelve a comprobar el programa completo.' };
        }
        if (response.status >= 400 && response.status < 500
          && error.success && error.data.error.code !== 'OPERATION_INTERRUPTED') clearOperation();
        return { kind: 'error', message: error.success ? error.data.error.message : 'El runtime local rechazó la operación.' };
      }
      const parsed = schema.safeParse(payload);
      if (parsed.success) clearOperation();
      return parsed.success
        ? { kind: 'success', value: parsed.data }
        : { kind: 'error', message: 'La respuesta del runtime local no es válida.' };
    } catch {
      return {
        kind: 'error',
        message: 'No se puede contactar con el runtime local. Comprueba que está arrancado en este PC y permite a esta web acceder a la red local.',
      };
    }
  };

  return Object.freeze({
    localAdminUrl: baseUrl === '' ? '/admin' : `${baseUrl}/admin`,
    readiness: () => request('/api/pilot/readiness', PilotReadinessSchema),
    operations: () => request('/api/pilot/operations', z.strictObject({ operations: z.array(PilotOperationSchema) })),
    incidents: () => request('/api/pilot/incidents', z.strictObject({ incidents: z.array(PilotIncidentSchema) })),
    recordings: () => request('/api/pilot/recordings', RecordingsEnvelopeSchema),
    createPublication: (assetId: string, input: { readonly title: string; readonly description: string }) => request(
      `/api/pilot/recordings/${encodeURIComponent(assetId)}/uploads`, PublicationEnvelopeSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      }),
    pausePublication: (jobId: string) => request(
      `/api/pilot/publications/${encodeURIComponent(jobId)}/pause`, PublicationEnvelopeSchema, { method: 'POST' }),
    resumePublication: (jobId: string) => request(
      `/api/pilot/publications/${encodeURIComponent(jobId)}/resume`, PublicationEnvelopeSchema, { method: 'POST' }),
    schedulePublication: (jobId: string, publishAt: string) => request(
      `/api/pilot/publications/${encodeURIComponent(jobId)}/schedule`, PublicationEnvelopeSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publishAt }),
      }),
    sessions: async (): Promise<PilotApiResult<readonly PilotSession[]>> => {
      const result = await request('/api/pilot/sessions', SessionsEnvelopeSchema);
      return result.kind === 'success'
        ? { kind: 'success', value: result.value.sessions.map((session) => localizeSession(session, baseUrl)) }
        : result;
    },
    configurations: async (): Promise<PilotApiResult<readonly PilotConfiguration[]>> => {
      const result = await request('/api/pilot/configurations', ConfigurationsEnvelopeSchema);
      return result.kind === 'success' ? { kind: 'success', value: result.value.configurations } : result;
    },
    teams: async (): Promise<PilotApiResult<readonly Team[]>> => {
      const result = await request('/api/teams', TeamsEnvelopeSchema);
      return result.kind === 'success' ? { kind: 'success', value: result.value.teams } : result;
    },
    mobileCameras: async (): Promise<PilotApiResult<readonly PilotMobileCameraSession[]>> => {
      const result = await request('/api/pilot/mobile-cameras', MobileCamerasEnvelopeSchema);
      return result.kind === 'success' ? { kind: 'success', value: result.value.mobileCameras } : result;
    },
    createMobileCamera: (courtSlug: PilotCourtSlug) => request('/api/pilot/mobile-camera', PilotMobileCameraLinkSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ courtSlug }),
    }),
    updateMobileCamera: async (id: string, input: UpdatePilotMobileCameraDesiredInput) => {
      const result = await request(`/api/pilot/mobile-camera/${encodeURIComponent(id)}/desired`, MobileCameraEnvelopeSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return result.kind === 'success' && result.value.mobileCamera !== null
        ? { kind: 'success' as const, value: result.value.mobileCamera }
        : result.kind === 'error' ? result : { kind: 'error' as const, message: 'La cámara móvil ya no está disponible.' };
    },
    revokeMobileCamera: async (id: string) => {
      const result = await request(`/api/pilot/mobile-camera/${encodeURIComponent(id)}`, MobileCameraEnvelopeSchema, { method: 'DELETE' });
      return result.kind === 'success' && result.value.mobileCamera !== null
        ? { kind: 'success' as const, value: result.value.mobileCamera }
        : result.kind === 'error' ? result : { kind: 'error' as const, message: 'La cámara móvil ya no está disponible.' };
    },
    thumbnailPreview: (input: PreparePilotSessionInput, signal?: AbortSignal) => request(
      '/api/pilot/thumbnail-preview', z.strictObject({ dataUrl: z.string().startsWith('data:image/png;base64,') }), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input), ...(signal ? { signal } : {}),
      },
    ),
    configure: async (input: PreparePilotSessionInput): Promise<PilotApiResult<PilotConfiguration>> => {
      const parsed = PreparePilotSessionInputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'error', message: 'Revisa la configuración de la pista.' };
      const result = await request(`/api/pilot/configurations/${encodeURIComponent(parsed.data.courtSlug)}`, ConfigurationEnvelopeSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      return result.kind === 'success' ? { kind: 'success', value: result.value.configuration } : result;
    },
    prepare: async (input: PreparePilotSessionInput): Promise<PilotApiResult<PilotSession>> => {
      const parsed = PreparePilotSessionInputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'error', message: 'Revisa los datos de la prueba.' };
      const result = await request('/api/pilot/sessions', SessionEnvelopeSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      return result.kind === 'success'
        ? { kind: 'success', value: localizeSession(result.value.session, baseUrl) }
        : result;
    },
    start: (id: string) => sessionMutation(id, 'start'),
    preflight: async (id: string, check?: PilotPreflightCheckId): Promise<PilotApiResult<PilotSession>> => {
      const result = await request(`/api/pilot/sessions/${encodeURIComponent(id)}/preflight`, SessionEnvelopeSchema, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(check ? { check } : {}),
      });
      return result.kind === 'success' ? { kind: 'success', value: localizeSession(result.value.session, baseUrl) } : result;
    },
    cancelPreflight: (id: string) => sessionMutation(id, 'preflight/cancel'),
    preview: async (path: string, signal: AbortSignal): Promise<PilotApiResult<Blob>> => {
      if (!/^\/api\/pilot\/sessions\/[0-9a-f-]{36}\/preflight-preview\/[0-9a-f-]{36}$/i.test(path)) {
        return { kind: 'error', message: 'La dirección de la vista previa no es válida.' };
      }
      try {
        const { data } = await supabase.auth.getSession();
        const init: LocalNetworkRequestInit = { signal, cache: 'no-store',
          headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {},
          ...(isLoopbackHttp(baseUrl) ? { targetAddressSpace: 'loopback' as const } : {}) };
        const response = await fetcher(`${baseUrl}${path}`, init);
        if (!response.ok || !response.headers.get('content-type')?.startsWith('video/mp4')) {
          return { kind: 'error', message: 'No se pudo abrir la vista previa. Revisa tu sesión y repite la comprobación si el archivo ya no está disponible.' };
        }
        return { kind: 'success', value: await response.blob() };
      } catch { return { kind: 'error', message: 'No se pudo descargar la vista previa del equipo de emisión.' }; }
    },
    recover: (id: string) => sessionMutation(id, 'recover'),
    stop: (id: string) => sessionMutation(id, 'stop'),
  });

  async function sessionMutation(id: string, action: 'start' | 'recover' | 'stop' | 'preflight/cancel'): Promise<PilotApiResult<PilotSession>> {
    const result = await request(`/api/pilot/sessions/${encodeURIComponent(id)}/${action}`, SessionEnvelopeSchema, {
      method: 'POST',
    });
    return result.kind === 'success'
      ? { kind: 'success', value: localizeSession(result.value.session, baseUrl) }
      : result;
  }
}

function localizeSession(session: PilotSession, baseUrl: string): PilotSession {
  if (baseUrl === '' || !session.thumbnailUrl.startsWith('/')) return session;
  return { ...session, thumbnailUrl: `${baseUrl}${session.thumbnailUrl}` };
}

function defaultLocalAgentBaseUrl(): string {
  const configured = import.meta.env.VITE_LOCAL_AGENT_URL?.trim();
  if (configured) return configured;
  if (typeof window === 'undefined') return '';
  if (window.location.protocol === 'http:' && window.location.port === '4310') return '';
  return 'http://127.0.0.1:4310';
}

function normalizeBaseUrl(value: string): string {
  const candidate = value.trim();
  if (candidate === '') return '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'http://127.0.0.1:4310';
    return url.origin;
  } catch {
    return 'http://127.0.0.1:4310';
  }
}

function isLoopbackHttp(baseUrl: string): boolean {
  if (!baseUrl.startsWith('http://')) return false;
  const hostname = new URL(baseUrl).hostname;
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}
