import { z } from 'zod';
import { PilotServiceError } from './pilot-service.js';

export type ProductionRuntimeCapability = 'production_admin' | 'operator';

export interface ProductionAccessGuard {
  require(authorization: string | undefined, required: ProductionRuntimeCapability): Promise<void>;
}

const CapabilitySchema = z.enum(['production_admin', 'operator']);

export class SupabaseProductionAccessGuard implements ProductionAccessGuard {
  public constructor(
    private readonly config: { url: string; publishableKey: string } | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async require(
    authorization: string | undefined,
    required: ProductionRuntimeCapability,
  ): Promise<void> {
    if (!this.config?.url || !this.config.publishableKey) {
      throw new PilotServiceError(503, 'NOT_READY', 'Falta la conexión con Supabase para autorizar el control.');
    }
    if (!authorization?.startsWith('Bearer ')) {
      throw new PilotServiceError(403, 'FORBIDDEN', 'Inicia sesión para controlar la producción.');
    }
    try {
      const response = await this.fetcher(
        `${this.config.url.replace(/\/+$/, '')}/rest/v1/rpc/production_runtime_capability`,
        {
          method: 'POST',
          headers: {
            apikey: this.config.publishableKey,
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new PilotServiceError(403, 'FORBIDDEN', 'No tienes permiso para controlar la producción.');
      }
      const capability = CapabilitySchema.safeParse(await response.json());
      if (!capability.success || (required === 'production_admin' && capability.data !== 'production_admin')) {
        throw new PilotServiceError(403, 'FORBIDDEN', 'No tienes permiso para realizar esta acción.');
      }
    } catch (error) {
      if (error instanceof PilotServiceError) throw error;
      throw new PilotServiceError(503, 'NOT_READY', 'No se pudo comprobar el permiso de producción en Supabase.');
    }
  }
}
