import { randomBytes } from 'node:crypto';
import type { CourtId } from '@kpl/production-contracts';
import { JsonLineLogger } from './agent-logger.js';
import { NodeEphemeralRuntimeFiles } from './ephemeral-runtime-files.js';
import { FfmpegCourtPipeline } from './ffmpeg-court-pipeline.js';
import { LocalSecretResolver } from './local-secret-resolver.js';
import { NodeProcessSpawner } from './managed-process.js';
import { MediaMtxApiClientFactory } from './mediamtx-api-client.js';
import { MediaMtxApiCredentialFactory } from './mediamtx-api-credentials.js';
import { MediaMtxService } from './mediamtx-service.js';
import { NodeScheduler } from './process-stop.js';
import type { ProductionAgentConfig } from './production-agent-config.js';
import { Supervisor, type CourtPipelinePorts } from './supervisor.js';
import {
  createAuthenticatedSupabaseControlPlane,
  createAuthenticatedSupabaseSdkClient,
} from './supabase-client.js';
import type { SupabaseControlPlane } from './supabase-control-plane.js';

type Four<Value> = readonly [Value, Value, Value, Value];

export type ProductionCourtComposition = {
  readonly courtId: CourtId;
  readonly pipeline: FfmpegCourtPipeline;
};

export type ProductionAgentComposition = {
  readonly controlPlane: SupabaseControlPlane;
  readonly courts: Four<ProductionCourtComposition>;
  readonly logger: JsonLineLogger;
  readonly mediaService: MediaMtxService;
  readonly pipelines: Four<FfmpegCourtPipeline>;
  readonly secretResolver: LocalSecretResolver;
  readonly supervisor: Supervisor;
};

export class ProductionCompositionError extends Error {
  public readonly code = 'INVALID_CONFIG' as const;

  public constructor() {
    super('Invalid production composition configuration');
    this.name = 'ProductionCompositionError';
  }
}

export function composeProductionAgent(config: ProductionAgentConfig): ProductionAgentComposition {
  const courtIds = requireFour(config.agent.courtIds);
  const scheduler = new NodeScheduler();
  const spawner = new NodeProcessSpawner();
  const mediaService = new MediaMtxService({
    config: config.media,
    runtimeFiles: new NodeEphemeralRuntimeFiles(),
    spawner,
    scheduler,
    credentialFactory: new MediaMtxApiCredentialFactory({
      randomBytes: (size) => randomBytes(size),
    }),
    apiClientFactory: new MediaMtxApiClientFactory(),
  });
  const clock = Object.freeze({ nowMs: () => Date.now() });
  const pipelines = courtIds.map((courtId) => new FfmpegCourtPipeline({
    config: config.media,
    courtId,
    spawner,
    scheduler,
    clock,
    mediaInspector: mediaService,
    overlayFactory: null,
  }));
  const courtPipelines = requireFour(pipelines);
  const courts = Object.freeze([
    { courtId: courtIds[0], pipeline: courtPipelines[0] },
    { courtId: courtIds[1], pipeline: courtPipelines[1] },
    { courtId: courtIds[2], pipeline: courtPipelines[2] },
    { courtId: courtIds[3], pipeline: courtPipelines[3] },
  ] as const);
  const supervisorConfig = {
    courts: courtIds.map((courtId) => ({ courtId })),
    maxConcurrentPipelines: 3,
  } as const;

  return Object.freeze({
    controlPlane: createAuthenticatedSupabaseControlPlane(
      createAuthenticatedSupabaseSdkClient(config.agent),
    ),
    courts,
    logger: new JsonLineLogger({
      clock: () => new Date(),
      write: (line) => { process.stdout.write(line); },
    }),
    mediaService,
    pipelines: courtPipelines,
    secretResolver: new LocalSecretResolver(config.agent.secretRootPath),
    supervisor: new Supervisor(supervisorConfig, courtPipelines satisfies CourtPipelinePorts),
  });
}

function requireFour<Value>(values: readonly Value[]): Four<Value> {
  const [first, second, third, fourth, extra] = values;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined
    || extra !== undefined) throw new ProductionCompositionError();
  return Object.freeze([first, second, third, fourth]);
}
