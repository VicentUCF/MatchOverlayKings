import { z } from 'zod';
import { PilotCourtSlugSchema, PilotSessionStatusSchema } from './pilot.js';
import { PilotSignalIssueCodeSchema } from './pilot-signal.js';

export const PilotOperationKindSchema = z.enum(['configure', 'prepare', 'preflight', 'start', 'recover', 'stop']);
export const PilotOperationSchema = z.strictObject({
  id: z.uuid(),
  kind: PilotOperationKindSchema,
  courtSlug: PilotCourtSlugSchema,
  sessionId: z.uuid().nullable(),
  matchdayNumber: z.number().int().positive().nullable(),
  seasonLabel: z.string().max(32).nullable(),
  status: z.enum(['pending', 'completed', 'failed', 'interrupted']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  message: z.string().max(500).nullable(),
}).readonly();

export type PilotOperation = z.infer<typeof PilotOperationSchema>;
export type PilotOperationKind = z.infer<typeof PilotOperationKindSchema>;

export const PilotMobileRuntimeCodeSchema = z.enum([
  'starting', 'ready', 'restored', 'process_exit', 'unresponsive', 'start_failed',
  'retry_scheduled', 'retrying', 'exhausted', 'manual_recovery', 'configuration_unavailable', 'revocation_restart',
]);
export type PilotMobileRuntimeCode = z.infer<typeof PilotMobileRuntimeCodeSchema>;

export const PilotIncidentSchema = z.strictObject({
  category: z.enum(['state', 'signal', 'continuity', 'overlay', 'mobile_runtime']).default('state'),
  mobileRuntimeCode: PilotMobileRuntimeCodeSchema.optional(),
  mobileSessionId: z.uuid().optional(),
  attempt: z.number().int().nonnegative().max(5).optional(),
  signalCode: PilotSignalIssueCodeSchema.optional(),
  resolved: z.boolean().optional(),
  id: z.uuid(),
  sessionId: z.uuid().nullable(),
  operationId: z.uuid().nullable(),
  courtSlug: PilotCourtSlugSchema,
  matchdayNumber: z.number().int().positive().nullable(),
  seasonLabel: z.string().max(32).nullable(),
  previousStatus: PilotSessionStatusSchema.nullable(),
  status: PilotSessionStatusSchema.nullable(),
  severity: z.enum(['info', 'warning', 'critical']),
  createdAt: z.iso.datetime(),
  message: z.string().max(500),
}).readonly();

export type PilotIncident = z.infer<typeof PilotIncidentSchema>;
