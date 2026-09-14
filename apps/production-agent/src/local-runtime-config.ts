import { isAbsolute } from 'node:path';
import { CourtIdSchema } from '@kpl/production-contracts';
import { z } from 'zod';

const environmentNames = [
  'KPL_AGENT_COURT_IDS',
  'KPL_AGENT_MAX_CONCURRENT_PIPELINES',
  'KPL_AGENT_SUPABASE_URL',
  'KPL_AGENT_SUPABASE_PUBLISHABLE_KEY',
  'KPL_AGENT_ACCESS_TOKEN',
  'KPL_AGENT_SECRET_ROOT',
  'KPL_AGENT_POLL_INTERVAL_MS',
  'KPL_AGENT_SHUTDOWN_DEADLINE_MS',
] as const;
const environmentNameSet = new Set<string>(environmentNames);
const REDACTED = '[REDACTED]';

export interface RuntimeCredential {
  readonly use: <Result>(consumer: (value: string) => Result) => Result;
  readonly toJSON: () => string;
  readonly toString: () => string;
}

class OpaqueRuntimeCredential implements RuntimeCredential {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
  }

  public use<Result>(consumer: (value: string) => Result): Result {
    return consumer(this.#value);
  }

  public toJSON(): string {
    return REDACTED;
  }

  public toString(): string {
    return REDACTED;
  }
}

const RuntimeCredentialSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() === value)
  .refine(hasNoControlCharacters)
  .transform((value) => new OpaqueRuntimeCredential(value));
const SupabaseOriginSchema = z
  .string()
  .refine((value) => value.trim() === value)
  .refine(hasNoControlCharacters)
  .pipe(z.url())
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'Expected an HTTPS origin' });
    }
  })
  .transform((value) => new URL(value).origin);
const BoundedIntegerStringSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int());
const FourCourtIdsSchema = CourtIdSchema
  .array()
  .length(4)
  .superRefine((courtIds, context) => {
    if (new Set(courtIds).size !== courtIds.length) {
      context.addIssue({ code: 'custom', message: 'Court IDs must be unique' });
    }
  })
  .readonly();

export const LocalAgentRuntimeConfigSchema = z
  .strictObject({
    courtIds: FourCourtIdsSchema,
    maxConcurrentPipelines: z.literal(3),
    supabaseUrl: SupabaseOriginSchema,
    supabasePublishableKey: RuntimeCredentialSchema,
    agentAccessToken: RuntimeCredentialSchema,
    secretRootPath: z.string().trim().min(1).refine(isAbsolute),
    pollIntervalMs: z.number().int().min(100).max(60_000),
    shutdownDeadlineMs: z.number().int().min(1_000).max(120_000),
  })
  .readonly();

export type LocalAgentRuntimeConfig = z.infer<typeof LocalAgentRuntimeConfigSchema>;

export class LocalAgentRuntimeConfigError extends Error {
  public readonly code = 'INVALID_CONFIG' as const;

  public constructor() {
    super('Invalid local agent runtime configuration');
    this.name = 'LocalAgentRuntimeConfigError';
  }
}

export function parseLocalAgentEnvironment(input: unknown): LocalAgentRuntimeConfig {
  const parsedEnvironment = z.record(z.string(), z.string().optional()).safeParse(input);
  if (!parsedEnvironment.success) throw new LocalAgentRuntimeConfigError();
  const environment = parsedEnvironment.data;
  const hasUnknownAgentField = Object.keys(environment).some(
    (name) => name.startsWith('KPL_AGENT_') && !environmentNameSet.has(name),
  );
  if (hasUnknownAgentField) throw new LocalAgentRuntimeConfigError();

  const parsedConfig = LocalAgentRuntimeConfigSchema.safeParse({
    courtIds: environment['KPL_AGENT_COURT_IDS']?.split(',').map((value) => value.trim()),
    maxConcurrentPipelines: parseInteger(environment['KPL_AGENT_MAX_CONCURRENT_PIPELINES']),
    supabaseUrl: environment['KPL_AGENT_SUPABASE_URL'],
    supabasePublishableKey: environment['KPL_AGENT_SUPABASE_PUBLISHABLE_KEY'],
    agentAccessToken: environment['KPL_AGENT_ACCESS_TOKEN'],
    secretRootPath: environment['KPL_AGENT_SECRET_ROOT'],
    pollIntervalMs: parseInteger(environment['KPL_AGENT_POLL_INTERVAL_MS']),
    shutdownDeadlineMs: parseInteger(environment['KPL_AGENT_SHUTDOWN_DEADLINE_MS']),
  });
  if (!parsedConfig.success) throw new LocalAgentRuntimeConfigError();
  return parsedConfig.data;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = BoundedIntegerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function hasNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && (code < 0x7f || code > 0x9f);
  });
}
