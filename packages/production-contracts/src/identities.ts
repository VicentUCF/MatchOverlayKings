import { z } from 'zod';
import {
  AssignmentIdSchema,
  ClubIdSchema,
  DeviceIdSchema,
  PrincipalIdSchema,
  ProductionEventIdSchema,
  TimestampSchema,
  VersionSchema,
  JsonValueSchema,
} from './common.js';

export const PrincipalKindSchema = z.enum(['human', 'agent', 'device']);
export const PrincipalRoleSchema = z.enum([
  'production_admin',
  'operator',
  'viewer',
  'agent',
  'device',
]);
export const AssignmentRoleSchema = z.enum(['operator', 'viewer', 'agent', 'capture']);
export const DeviceKindSchema = z.enum(['camera', 'encoder', 'controller', 'display']);

export const PrincipalSchema = z
  .strictObject({
    id: PrincipalIdSchema,
    clubId: ClubIdSchema,
    kind: PrincipalKindSchema,
    displayName: z.string().trim().min(1).max(160),
    active: z.boolean(),
    version: VersionSchema,
  })
  .readonly();

export const PrincipalRoleGrantSchema = z
  .strictObject({
    principalId: PrincipalIdSchema,
    clubId: ClubIdSchema,
    role: PrincipalRoleSchema,
  })
  .readonly();

export const ProductionAssignmentSchema = z
  .strictObject({
    id: AssignmentIdSchema,
    eventId: ProductionEventIdSchema,
    principalId: PrincipalIdSchema,
    role: AssignmentRoleSchema,
    active: z.boolean(),
    version: VersionSchema,
  })
  .readonly();

export const DeviceSchema = z
  .strictObject({
    id: DeviceIdSchema,
    clubId: ClubIdSchema,
    principalId: PrincipalIdSchema,
    name: z.string().trim().min(1).max(160),
    kind: DeviceKindSchema,
    enabled: z.boolean(),
    lastHeartbeatAt: TimestampSchema.nullable(),
    version: VersionSchema,
  })
  .readonly();

export const DeviceHeartbeatSchema = z
  .strictObject({
    status: JsonValueSchema,
    reportedAt: TimestampSchema,
  })
  .readonly();

export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;
export type AssignmentRole = z.infer<typeof AssignmentRoleSchema>;
export type DeviceKind = z.infer<typeof DeviceKindSchema>;
export type Principal = z.infer<typeof PrincipalSchema>;
export type PrincipalRoleGrant = z.infer<typeof PrincipalRoleGrantSchema>;
export type ProductionAssignment = z.infer<typeof ProductionAssignmentSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceHeartbeat = z.infer<typeof DeviceHeartbeatSchema>;
