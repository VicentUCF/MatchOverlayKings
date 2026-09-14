import { z } from 'zod';
import { AssetKindSchema } from './assets.js';
import {
  AssetSpecIdSchema,
  AssignmentIdSchema,
  AuthUserIdSchema,
  ClubIdSchema,
  CommandIdSchema,
  DateSchema,
  DeviceIdSchema,
  EventDayIdSchema,
  ExpectedVersionSchema,
  JsonValueSchema,
  LocalSecretRefSchema,
  OutputIdSchema,
  PrincipalIdSchema,
  ProductionEventIdSchema,
} from './common.js';
import {
  AssignmentRoleSchema,
  DeviceKindSchema,
} from './identities.js';
import { OutputKindSchema, OutputTransportSchema } from './outputs.js';
import { EventDayStatusSchema } from './scheduling.js';

const versionedCommandFields = {
  expectedVersion: ExpectedVersionSchema,
  commandId: CommandIdSchema,
} as const;

export const UpsertEventDayCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    eventDayId: EventDayIdSchema,
    clubId: ClubIdSchema,
    name: z.string().trim().min(1).max(160),
    eventDate: DateSchema,
    timeZone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z0-9_+/-]+$/),
    status: EventDayStatusSchema,
  })
  .readonly();

export const UpsertMachinePrincipalCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    principalId: PrincipalIdSchema,
    clubId: ClubIdSchema,
    authUserId: AuthUserIdSchema,
    kind: z.enum(['agent', 'device']),
    displayName: z.string().trim().min(1).max(160),
    active: z.boolean(),
  })
  .readonly();

export const UpsertDeviceCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    deviceId: DeviceIdSchema,
    principalId: PrincipalIdSchema,
    name: z.string().trim().min(1).max(160),
    kind: DeviceKindSchema,
    secretRef: LocalSecretRefSchema,
    enabled: z.boolean(),
  })
  .readonly();

export const UpsertOutputCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    outputId: OutputIdSchema,
    eventId: ProductionEventIdSchema,
    name: z.string().trim().min(1).max(160),
    kind: OutputKindSchema,
    transport: OutputTransportSchema,
    secretRef: LocalSecretRefSchema.nullable(),
    enabled: z.boolean(),
  })
  .readonly();

export const UpsertAssignmentCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    assignmentId: AssignmentIdSchema,
    eventId: ProductionEventIdSchema,
    principalId: PrincipalIdSchema,
    role: AssignmentRoleSchema,
    active: z.boolean(),
  })
  .readonly();

export const RegisterAssetSpecCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    assetSpecId: AssetSpecIdSchema,
    eventId: ProductionEventIdSchema,
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(200),
    kind: AssetKindSchema,
    uri: z.string().regex(/^asset:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    metadata: JsonValueSchema,
  })
  .readonly();

export const SetHumanRoleCommandSchema = z
  .strictObject({
    ...versionedCommandFields,
    principalId: PrincipalIdSchema,
    role: z.enum(['operator', 'viewer']),
    granted: z.boolean(),
  })
  .readonly();

export type UpsertEventDayCommand = z.infer<typeof UpsertEventDayCommandSchema>;
export type UpsertMachinePrincipalCommand = z.infer<typeof UpsertMachinePrincipalCommandSchema>;
export type UpsertDeviceCommand = z.infer<typeof UpsertDeviceCommandSchema>;
export type UpsertOutputCommand = z.infer<typeof UpsertOutputCommandSchema>;
export type UpsertAssignmentCommand = z.infer<typeof UpsertAssignmentCommandSchema>;
export type RegisterAssetSpecCommand = z.infer<typeof RegisterAssetSpecCommandSchema>;
export type SetHumanRoleCommand = z.infer<typeof SetHumanRoleCommandSchema>;
