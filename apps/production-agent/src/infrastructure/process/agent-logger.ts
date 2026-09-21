import {
  CourtIdSchema,
  ObservedHealthSchema,
  OperationIdSchema,
  OutputIdSchema,
  VersionSchema,
} from '@kpl/production-contracts';
import { z } from 'zod';

const AgentLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
const AgentLogEventSchema = z.enum([
  'agent_started',
  'agent_stopped',
  'snapshot_loaded',
  'operation_claimed',
  'operation_completed',
  'output_health',
  'retry_scheduled',
  'agent_error',
]);
const AgentLogErrorCodeSchema = z.enum([
  'ABORTED',
  'CONFIG_INVALID',
  'CONFLICT',
  'FORBIDDEN',
  'INVALID_ARGUMENT',
  'MALFORMED_RESPONSE',
  'NOT_FOUND',
  'REQUEST_FAILED',
  'SECRET_EMPTY',
  'SECRET_INVALID',
  'SECRET_IO_ERROR',
  'SECRET_TOO_LARGE',
  'SECRET_UNSAFE_PATH',
]);

const AgentLogFieldsSchema = z
  .strictObject({
    courtId: CourtIdSchema.optional(),
    outputId: OutputIdSchema.optional(),
    desiredVersion: VersionSchema.optional(),
    operationId: OperationIdSchema.optional(),
    health: ObservedHealthSchema.optional(),
    attempt: z.number().int().min(1).max(100).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    errorCode: AgentLogErrorCodeSchema.optional(),
  })
  .readonly();

export type AgentLogLevel = z.infer<typeof AgentLogLevelSchema>;
export type AgentLogEvent = z.infer<typeof AgentLogEventSchema>;
export type AgentLogFields = z.infer<typeof AgentLogFieldsSchema>;

export interface AgentLogger {
  readonly log: (
    level: AgentLogLevel,
    event: AgentLogEvent,
    fields?: AgentLogFields,
  ) => void;
}

export type JsonLineLoggerOptions = {
  readonly clock: () => Date;
  readonly write: (line: string) => void;
};

export class AgentLoggerError extends Error {
  public readonly code = 'INVALID_RECORD' as const;

  public constructor() {
    super('Invalid agent log record');
    this.name = 'AgentLoggerError';
  }
}

export class JsonLineLogger implements AgentLogger {
  readonly #clock: () => Date;
  readonly #write: (line: string) => void;

  public constructor(options: JsonLineLoggerOptions) {
    this.#clock = options.clock;
    this.#write = options.write;
  }

  public log(levelInput: AgentLogLevel, eventInput: AgentLogEvent, fieldsInput: AgentLogFields = {}): void {
    const level = AgentLogLevelSchema.safeParse(levelInput);
    const event = AgentLogEventSchema.safeParse(eventInput);
    const fields = AgentLogFieldsSchema.safeParse(fieldsInput);
    if (!level.success || !event.success || !fields.success) throw new AgentLoggerError();
    this.#write(`${JSON.stringify({
      level: level.data,
      time: this.#clock().toISOString(),
      event: event.data,
      ...fields.data,
    })}\n`);
  }
}
