import { z } from 'zod';
import {
  CommandIdSchema,
  CourtSlugSchema,
  EventDayIdSchema,
  ExpectedVersionSchema,
  JsonValueSchema,
  OutputIdSchema,
  OperationIdSchema,
  ProductionEventIdSchema,
  TimestampSchema,
} from './common.js';
import { DesiredOutputSpecSchema, ObservedHealthSchema } from './outputs.js';
import { OperationKindSchema, OperationPayloadSchema } from './operations.js';
import { OperationCompletionStatusSchema, OperationResultSchema } from './operations.js';
import { ProductionEventStatusSchema } from './scheduling.js';

const humanCommandFields = {
  expectedVersion: ExpectedVersionSchema,
  commandId: CommandIdSchema,
} as const;

export const HumanCommandSchema = z.strictObject(humanCommandFields).readonly();

export const ScheduleProductionEventCommandSchema = z
  .strictObject({
    ...humanCommandFields,
    eventId: ProductionEventIdSchema,
    eventDayId: EventDayIdSchema,
    courtSlug: CourtSlugSchema,
    title: z.string().trim().min(1).max(200),
    scheduledStartAt: TimestampSchema,
    scheduledEndAt: TimestampSchema,
  })
  .refine(
    (command) => Date.parse(command.scheduledEndAt) > Date.parse(command.scheduledStartAt),
    { message: 'scheduledEndAt must be after scheduledStartAt', path: ['scheduledEndAt'] },
  )
  .readonly();

export const SetProductionEventStatusCommandSchema = z
  .strictObject({
    ...humanCommandFields,
    eventId: ProductionEventIdSchema,
    status: ProductionEventStatusSchema,
  })
  .readonly();

export const SetDesiredStateCommandSchema = z
  .strictObject({
    ...humanCommandFields,
    outputId: OutputIdSchema,
    desired: DesiredOutputSpecSchema,
    operationKind: OperationKindSchema,
    operationPayload: OperationPayloadSchema,
  })
  .readonly();

export const ReportObservedStateCommandSchema = z
  .strictObject({
    outputId: OutputIdSchema,
    sequence: z.number().int().nonnegative(),
    health: ObservedHealthSchema,
    state: JsonValueSchema,
  })
  .readonly();

export const CompleteOperationCommandSchema = z
  .strictObject({
    operationId: OperationIdSchema,
    status: OperationCompletionStatusSchema,
    result: OperationResultSchema,
  })
  .readonly();

export type HumanCommand = z.infer<typeof HumanCommandSchema>;
export type ScheduleProductionEventCommand = z.infer<typeof ScheduleProductionEventCommandSchema>;
export type SetProductionEventStatusCommand = z.infer<typeof SetProductionEventStatusCommandSchema>;
export type SetDesiredStateCommand = z.infer<typeof SetDesiredStateCommandSchema>;
export type ReportObservedStateCommand = z.infer<typeof ReportObservedStateCommandSchema>;
export type CompleteOperationCommand = z.infer<typeof CompleteOperationCommandSchema>;
