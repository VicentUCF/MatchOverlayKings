import { z } from 'zod';
import {
  PilotConfigurationSchema,
  PilotConfigurationsSchema,
  PilotReadinessSchema,
  PilotMobileCameraLinkSchema,
  PilotMobileCameraSessionSchema,
  PilotSessionSchema,
  PilotSessionsSchema,
  PreparePilotSessionInputSchema,
  type PilotConfiguration,
  type PilotCourtSlug,
  type PilotMobileCameraSession,
  type PilotSession,
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

export type PilotApiResult<Value> =
  | { readonly kind: 'success'; readonly value: Value }
  | { readonly kind: 'error'; readonly message: string };

export type ProductionPilotAdapter = ReturnType<typeof createProductionPilotAdapter>;

export function createProductionPilotAdapter(fetcher: typeof fetch = fetch) {
  const request = async <Value>(
    path: string,
    schema: z.ZodType<Value>,
    init?: RequestInit,
  ): Promise<PilotApiResult<Value>> => {
    try {
      const response = await fetcher(path, init);
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = ErrorEnvelopeSchema.safeParse(payload);
        return { kind: 'error', message: error.success ? error.data.error.message : 'El agente local rechazó la operación.' };
      }
      const parsed = schema.safeParse(payload);
      return parsed.success
        ? { kind: 'success', value: parsed.data }
        : { kind: 'error', message: 'La respuesta del agente local no es válida.' };
    } catch {
      return { kind: 'error', message: 'No se puede contactar con el agente local. Abre el piloto desde el servidor KPL del PC.' };
    }
  };

  return Object.freeze({
    readiness: () => request('/api/pilot/readiness', PilotReadinessSchema),
    sessions: async (): Promise<PilotApiResult<readonly PilotSession[]>> => {
      const result = await request('/api/pilot/sessions', SessionsEnvelopeSchema);
      return result.kind === 'success' ? { kind: 'success', value: result.value.sessions } : result;
    },
    configurations: async (): Promise<PilotApiResult<readonly PilotConfiguration[]>> => {
      const result = await request('/api/pilot/configurations', ConfigurationsEnvelopeSchema);
      return result.kind === 'success' ? { kind: 'success', value: result.value.configurations } : result;
    },
    mobileCamera: async (): Promise<PilotApiResult<PilotMobileCameraSession | null>> => {
      const result = await request('/api/pilot/mobile-camera', MobileCameraEnvelopeSchema);
      return result.kind === 'success' ? { kind: 'success', value: result.value.mobileCamera } : result;
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
      return result.kind === 'success' ? { kind: 'success', value: result.value.session } : result;
    },
    start: (id: string) => sessionMutation(id, 'start'),
    stop: (id: string) => sessionMutation(id, 'stop'),
  });

  async function sessionMutation(id: string, action: 'start' | 'stop'): Promise<PilotApiResult<PilotSession>> {
    const result = await request(`/api/pilot/sessions/${encodeURIComponent(id)}/${action}`, SessionEnvelopeSchema, {
      method: 'POST',
    });
    return result.kind === 'success' ? { kind: 'success', value: result.value.session } : result;
  }
}
