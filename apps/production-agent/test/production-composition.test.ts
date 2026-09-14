import { describe, expect, it } from 'vitest';
import {
  FfmpegCourtPipeline,
  JsonLineLogger,
  LocalAgentRuntimeConfigSchema,
  LocalMediaRuntimeConfigSchema,
  LocalSecretResolver,
  MediaMtxService,
  SupabaseControlPlane,
  Supervisor,
  composeProductionAgent,
} from '../src/index.js';
import { COURT_IDS, productionEnvironment, productionMediaConfig } from './production-agent-fixture.js';

describe('production composition root', () => {
  it('composes the fixed four-court topology in configured order', () => {
    // Given
    const agent = LocalAgentRuntimeConfigSchema.parse({
      courtIds: COURT_IDS,
      maxConcurrentPipelines: 3,
      supabaseUrl: productionEnvironment()['KPL_AGENT_SUPABASE_URL'],
      supabasePublishableKey: productionEnvironment()['KPL_AGENT_SUPABASE_PUBLISHABLE_KEY'],
      agentAccessToken: productionEnvironment()['KPL_AGENT_ACCESS_TOKEN'],
      secretRootPath: productionEnvironment()['KPL_AGENT_SECRET_ROOT'],
      pollIntervalMs: 1000,
      shutdownDeadlineMs: 30_000,
    });
    const media = LocalMediaRuntimeConfigSchema.parse(productionMediaConfig());

    // When
    const composition = composeProductionAgent({ agent, media });

    // Then
    expect(composition.mediaService).toBeInstanceOf(MediaMtxService);
    expect(composition.courts.map(({ courtId }) => courtId)).toEqual(COURT_IDS);
    expect(composition.pipelines).toHaveLength(4);
    expect(composition.pipelines.every((pipeline) => pipeline instanceof FfmpegCourtPipeline)).toBe(true);
    expect(composition.supervisor).toBeInstanceOf(Supervisor);
    expect(composition.secretResolver).toBeInstanceOf(LocalSecretResolver);
    expect(composition.logger).toBeInstanceOf(JsonLineLogger);
    expect(composition.controlPlane).toBeInstanceOf(SupabaseControlPlane);
  });
});
