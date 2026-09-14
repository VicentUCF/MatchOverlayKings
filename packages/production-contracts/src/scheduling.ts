import { z } from 'zod';
import {
  ClubIdSchema,
  CourtIdSchema,
  DateSchema,
  EventDayIdSchema,
  ProductionEventIdSchema,
  TimestampSchema,
  VersionSchema,
} from './common.js';

export const EventDayStatusSchema = z.enum(['draft', 'active', 'completed', 'cancelled']);
export const ProductionEventStatusSchema = z.enum([
  'scheduled',
  'ready',
  'live',
  'completed',
  'cancelled',
]);

export const ProductionEventDaySchema = z
  .strictObject({
    id: EventDayIdSchema,
    clubId: ClubIdSchema,
    name: z.string().trim().min(1).max(160),
    eventDate: DateSchema,
    timeZone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z0-9_+/-]+$/),
    status: EventDayStatusSchema,
    version: VersionSchema,
  })
  .readonly();

export const ProductionEventSchema = z
  .strictObject({
    id: ProductionEventIdSchema,
    eventDayId: EventDayIdSchema,
    clubId: ClubIdSchema,
    courtId: CourtIdSchema,
    title: z.string().trim().min(1).max(200),
    scheduledStartAt: TimestampSchema,
    scheduledEndAt: TimestampSchema,
    status: ProductionEventStatusSchema,
    version: VersionSchema,
  })
  .refine(
    (event) => Date.parse(event.scheduledEndAt) > Date.parse(event.scheduledStartAt),
    { message: 'scheduledEndAt must be after scheduledStartAt', path: ['scheduledEndAt'] },
  )
  .readonly();

export type EventDayStatus = z.infer<typeof EventDayStatusSchema>;
export type ProductionEventStatus = z.infer<typeof ProductionEventStatusSchema>;
export type ProductionEventDay = z.infer<typeof ProductionEventDaySchema>;
export type ProductionEvent = z.infer<typeof ProductionEventSchema>;
