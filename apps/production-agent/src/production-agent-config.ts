import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  parseLocalAgentEnvironment,
  type LocalAgentRuntimeConfig,
} from './local-runtime-config.js';
import {
  LocalMediaRuntimeConfigSchema,
  type LocalMediaRuntimeConfig,
} from './media-runtime-config.js';

const MediaConfigPathSchema = z.string().min(1).refine(isAbsolute);

export type ProductionAgentConfig = {
  readonly agent: LocalAgentRuntimeConfig;
  readonly media: LocalMediaRuntimeConfig;
};

export class ProductionAgentConfigError extends Error {
  public readonly code = 'INVALID_CONFIG' as const;

  public constructor() {
    super('Invalid production agent configuration');
    this.name = 'ProductionAgentConfigError';
  }
}

export async function loadProductionAgentConfig(
  environmentInput: unknown,
  mediaConfigPathInput: unknown,
): Promise<ProductionAgentConfig> {
  const mediaConfigPath = MediaConfigPathSchema.safeParse(mediaConfigPathInput);
  if (!mediaConfigPath.success) throw new ProductionAgentConfigError();

  let mediaJson: string;
  try {
    mediaJson = await readFile(mediaConfigPath.data, 'utf8');
  } catch {
    throw new ProductionAgentConfigError();
  }

  let mediaInput: unknown;
  try {
    mediaInput = JSON.parse(mediaJson);
  } catch {
    throw new ProductionAgentConfigError();
  }

  return parseProductionAgentConfig(environmentInput, mediaInput);
}

export function parseProductionAgentConfig(
  environmentInput: unknown,
  mediaInput: unknown,
): ProductionAgentConfig {
  let agent: LocalAgentRuntimeConfig;
  try {
    agent = parseLocalAgentEnvironment(environmentInput);
  } catch {
    throw new ProductionAgentConfigError();
  }
  const media = LocalMediaRuntimeConfigSchema.safeParse(mediaInput);
  if (!media.success) throw new ProductionAgentConfigError();
  const mediaCourts = new Set(media.data.courtIds);
  if (mediaCourts.size !== agent.courtIds.length
    || agent.courtIds.some((courtId) => !mediaCourts.has(courtId))) {
    throw new ProductionAgentConfigError();
  }
  return Object.freeze({ agent, media: media.data });
}
