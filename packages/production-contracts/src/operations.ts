import { z } from 'zod';
import {
  ClubIdSchema,
  CommandIdSchema,
  CourtIdSchema,
  OperationIdSchema,
  OutputIdSchema,
  PrincipalIdSchema,
  ProductionEventIdSchema,
  TimestampSchema,
} from './common.js';

export const OperationKindSchema = z.enum([
  'start',
  'stop',
  'reconcile',
  'reload',
  'take',
  'clear',
]);
export const OperationClaimStatusSchema = z.enum(['claimed', 'completed', 'failed']);
export const OperationPayloadSchema = z.strictObject({}).readonly();
export const OperationCompletionStatusSchema = z.enum(['completed', 'failed']);
export const OperationResultSchema = z
  .strictObject({
    summary: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  })
  .readonly();

export const OperationSchema = z
  .strictObject({
    id: OperationIdSchema,
    clubId: ClubIdSchema,
    eventId: ProductionEventIdSchema,
    courtId: CourtIdSchema,
    outputId: OutputIdSchema.nullable(),
    commandId: CommandIdSchema,
    kind: OperationKindSchema,
    payload: OperationPayloadSchema,
    requestedByPrincipalId: PrincipalIdSchema,
    createdAt: TimestampSchema,
  })
  .readonly();

export const OperationClaimSchema = z
  .strictObject({
    operationId: OperationIdSchema,
    agentPrincipalId: PrincipalIdSchema,
    status: OperationClaimStatusSchema,
    claimedAt: TimestampSchema,
    leaseExpiresAt: TimestampSchema,
    result: OperationResultSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .readonly();

export type OperationKind = z.infer<typeof OperationKindSchema>;
export type OperationClaimStatus = z.infer<typeof OperationClaimStatusSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type OperationClaim = z.infer<typeof OperationClaimSchema>;
export type OperationResult = z.infer<typeof OperationResultSchema>;
