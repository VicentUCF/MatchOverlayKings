import { z } from 'zod';

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.null(),
    z.array(JsonValueSchema).readonly(),
    z.record(z.string(), JsonValueSchema).readonly(),
  ]),
);

export const ClubIdSchema = z.uuid().brand<'ClubId'>();
export const CourtIdSchema = z.uuid().brand<'CourtId'>();
export const EventDayIdSchema = z.uuid().brand<'EventDayId'>();
export const ProductionEventIdSchema = z.uuid().brand<'ProductionEventId'>();
export const PrincipalIdSchema = z.uuid().brand<'PrincipalId'>();
export const DeviceIdSchema = z.uuid().brand<'DeviceId'>();
export const AssignmentIdSchema = z.uuid().brand<'AssignmentId'>();
export const OutputIdSchema = z.uuid().brand<'OutputId'>();
export const OperationIdSchema = z.uuid().brand<'OperationId'>();
export const AssetSpecIdSchema = z.uuid().brand<'AssetSpecId'>();
export const AuthUserIdSchema = z.uuid().brand<'AuthUserId'>();
export const CourtSlugSchema = z.string().regex(/^pista-[a-z0-9-]+$/).brand<'CourtSlug'>();
export const CommandIdSchema = z.string().trim().min(1).max(128).brand<'CommandId'>();
export const LocalSecretRefSchema = z
  .string()
  .regex(/^local:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .brand<'LocalSecretRef'>();
export const TimestampSchema = z.iso.datetime({ offset: true }).brand<'Timestamp'>();
export const DateSchema = z.iso.date().brand<'IsoDate'>();
export const VersionSchema = z.number().int().positive().brand<'Version'>();
export const ExpectedVersionSchema = z.number().int().nonnegative().brand<'ExpectedVersion'>();

export type ClubId = z.infer<typeof ClubIdSchema>;
export type CourtId = z.infer<typeof CourtIdSchema>;
export type EventDayId = z.infer<typeof EventDayIdSchema>;
export type ProductionEventId = z.infer<typeof ProductionEventIdSchema>;
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type AssignmentId = z.infer<typeof AssignmentIdSchema>;
export type OutputId = z.infer<typeof OutputIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type AssetSpecId = z.infer<typeof AssetSpecIdSchema>;
export type AuthUserId = z.infer<typeof AuthUserIdSchema>;
export type CourtSlug = z.infer<typeof CourtSlugSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type LocalSecretRef = z.infer<typeof LocalSecretRefSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type IsoDate = z.infer<typeof DateSchema>;
export type Version = z.infer<typeof VersionSchema>;
export type ExpectedVersion = z.infer<typeof ExpectedVersionSchema>;
