import { z } from 'zod';
import {
  LocalSecretRefSchema,
  ScheduleProductionEventCommandSchema,
  SetProductionEventStatusCommandSchema,
  UpsertAssignmentCommandSchema,
  UpsertDeviceCommandSchema,
  UpsertEventDayCommandSchema,
  UpsertMachinePrincipalCommandSchema,
  UpsertOutputCommandSchema,
  type Device,
  type Output,
  type Principal,
  type ProductionAssignment,
  type ProductionEvent,
  type ProductionEventDay,
} from '@kpl/production-contracts';

export const UpsertEventDayInputSchema = UpsertEventDayCommandSchema
  .unwrap()
  .omit({ commandId: true })
  .readonly();

export const UpsertMachinePrincipalInputSchema = UpsertMachinePrincipalCommandSchema
  .unwrap()
  .omit({ commandId: true })
  .readonly();

export const UpsertDeviceInputSchema = UpsertDeviceCommandSchema
  .unwrap()
  .omit({ commandId: true })
  .readonly();

const scheduleCommandShape = ScheduleProductionEventCommandSchema.unwrap().shape;

export const ScheduleProductionEventInputSchema = z
  .strictObject({
    expectedVersion: scheduleCommandShape.expectedVersion,
    eventId: scheduleCommandShape.eventId,
    eventDayId: scheduleCommandShape.eventDayId,
    courtSlug: scheduleCommandShape.courtSlug,
    title: scheduleCommandShape.title,
    scheduledStartAt: scheduleCommandShape.scheduledStartAt,
    scheduledEndAt: scheduleCommandShape.scheduledEndAt,
  })
  .refine(
    (command) => Date.parse(command.scheduledEndAt) > Date.parse(command.scheduledStartAt),
    { message: 'scheduledEndAt must be after scheduledStartAt', path: ['scheduledEndAt'] },
  )
  .readonly();

export const UpsertAssignmentInputSchema = UpsertAssignmentCommandSchema
  .unwrap()
  .omit({ commandId: true })
  .readonly();

export const UpsertSrtProgramOutputInputSchema = UpsertOutputCommandSchema
  .unwrap()
  .omit({ commandId: true })
  .extend({
    kind: z.literal('program'),
    transport: z.literal('srt'),
    secretRef: LocalSecretRefSchema,
  })
  .readonly();

export const SetProductionEventStatusInputSchema = SetProductionEventStatusCommandSchema
  .unwrap()
  .omit({ commandId: true })
  .readonly();

export type ProductionProvisioningResult<Value> =
  | { readonly kind: 'accepted'; readonly value: Value }
  | { readonly kind: 'validation' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'conflict'; readonly currentVersion: number }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'transport' };

export type ProductionProvisioningAdapter = {
  readonly upsertEventDay: (input: unknown) => Promise<ProductionProvisioningResult<ProductionEventDay>>;
  readonly upsertMachinePrincipal: (input: unknown) => Promise<ProductionProvisioningResult<Principal>>;
  readonly upsertDevice: (input: unknown) => Promise<ProductionProvisioningResult<Device>>;
  readonly scheduleEvent: (input: unknown) => Promise<ProductionProvisioningResult<ProductionEvent>>;
  readonly upsertAssignment: (input: unknown) => Promise<ProductionProvisioningResult<ProductionAssignment>>;
  readonly upsertOutput: (input: unknown) => Promise<ProductionProvisioningResult<Output>>;
  readonly setEventStatus: (input: unknown) => Promise<ProductionProvisioningResult<ProductionEvent>>;
};
