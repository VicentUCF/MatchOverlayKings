import { z } from 'zod';
import {
  PilotReadinessSchema,
  PilotSessionSchema,
  PilotSessionsSchema,
  PreparePilotSessionInputSchema,
  type PilotSession,
  type PreparePilotSessionInput,
} from '@kpl/production-contracts';

const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
const SessionEnvelopeSchema = z.strictObject({ session: PilotSessionSchema });
const SessionsEnvelopeSchema = z.strictObject({ sessions: PilotSessionsSchema });

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
