import type { PreparePilotSessionInput } from '@kpl/production-contracts';
import { PilotServiceError } from './pilot-service.js';

export interface PilotMatchIdentity {
  readonly homeTeamId: string;
  readonly awayTeamId: string;
}

export interface PilotMatchBinding {
  configure(input: PreparePilotSessionInput, authorization?: string): Promise<PilotMatchIdentity>;
  assertConfigured(input: PreparePilotSessionInput, authorization?: string): Promise<PilotMatchIdentity>;
}

/** Uses the administrator's session; never grants the local agent database admin credentials. */
export class SupabasePilotMatchBinding implements PilotMatchBinding {
  public constructor(
    private readonly config: { url: string; publishableKey: string } | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public configure(input: PreparePilotSessionInput, authorization?: string): Promise<PilotMatchIdentity> {
    return this.call(input, true, authorization);
  }

  public assertConfigured(input: PreparePilotSessionInput, authorization?: string): Promise<PilotMatchIdentity> {
    return this.call(input, false, authorization);
  }

  private async call(input: PreparePilotSessionInput, configure: boolean, authorization?: string): Promise<PilotMatchIdentity> {
    if (!this.config?.url || !this.config.publishableKey) {
      throw new PilotServiceError(503, 'NOT_READY', 'Falta la conexión con Supabase para vincular la emisión y el marcador.');
    }
    if (!authorization?.startsWith('Bearer ')) {
      throw new PilotServiceError(403, 'FORBIDDEN', 'Inicia sesión como administrador para configurar o preparar la emisión.');
    }
    try {
      const response = await this.fetcher(`${this.config.url.replace(/\/+$/, '')}/rest/v1/rpc/configure_pilot_match`, {
        method: 'POST',
        headers: { apikey: this.config.publishableKey, Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_configuration: input, p_apply: configure }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json() as { homeTeamId?: unknown; awayTeamId?: unknown; message?: unknown };
      if (!response.ok) {
        throw new PilotServiceError(409, 'CONFLICT', typeof payload.message === 'string'
          ? payload.message : 'No se puede confirmar el partido configurado. Guarda la configuración de nuevo.');
      }
      if (typeof payload.homeTeamId !== 'string' || typeof payload.awayTeamId !== 'string') throw new Error('Invalid identity');
      return { homeTeamId: payload.homeTeamId, awayTeamId: payload.awayTeamId };
    } catch (error) {
      if (error instanceof PilotServiceError) throw error;
      throw new PilotServiceError(503, 'NOT_READY', 'No se puede comprobar el partido en Supabase. No se ha preparado la emisión.');
    }
  }
}
