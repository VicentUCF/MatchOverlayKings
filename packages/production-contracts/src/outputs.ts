import { z } from 'zod';
import {
  ClubIdSchema,
  CommandIdSchema,
  CourtIdSchema,
  DeviceIdSchema,
  JsonValueSchema,
  OutputIdSchema,
  PrincipalIdSchema,
  ProductionEventIdSchema,
  TimestampSchema,
  VersionSchema,
} from './common.js';

export const OutputKindSchema = z.enum(['program', 'clean', 'preview', 'recording']);
export const OutputTransportSchema = z.enum(['srt', 'rtmp', 'hls', 'local']);
export const ObservedHealthSchema = z.enum(['unknown', 'healthy', 'degraded', 'failed', 'offline']);
export const DesiredLifecycleSchema = z.enum(['off', 'preflight', 'running', 'stopped']);

export const CourtProgramProfileSchema = z
  .strictObject({
    courtId: CourtIdSchema,
    videoSourceDeviceId: DeviceIdSchema,
    width: z.number().int().min(640).max(7680),
    height: z.number().int().min(360).max(4320),
    framesPerSecond: z.number().int().min(24).max(120),
    videoBitrateKbps: z.number().int().min(500).max(100_000),
    audioSourceDeviceId: DeviceIdSchema.nullable(),
    audioBitrateKbps: z.number().int().min(32).max(512),
    overlayEnabled: z.boolean(),
  })
  .readonly();

export const DesiredOutputSpecSchema = z
  .strictObject({
    lifecycle: DesiredLifecycleSchema,
    profile: CourtProgramProfileSchema,
  })
  .readonly();

export const OutputSchema = z
  .strictObject({
    id: OutputIdSchema,
    eventId: ProductionEventIdSchema,
    clubId: ClubIdSchema,
    courtId: CourtIdSchema,
    name: z.string().trim().min(1).max(160),
    kind: OutputKindSchema,
    transport: OutputTransportSchema,
    enabled: z.boolean(),
    version: VersionSchema,
  })
  .readonly();

export const DesiredOutputStateSchema = z
  .strictObject({
    outputId: OutputIdSchema,
    clubId: ClubIdSchema,
    eventId: ProductionEventIdSchema,
    version: VersionSchema,
    desired: DesiredOutputSpecSchema,
    updatedAt: TimestampSchema,
    updatedByPrincipalId: PrincipalIdSchema,
    commandId: CommandIdSchema,
  })
  .readonly();

export const ObservedOutputStateSchema = z
  .strictObject({
    outputId: OutputIdSchema,
    clubId: ClubIdSchema,
    eventId: ProductionEventIdSchema,
    agentPrincipalId: PrincipalIdSchema,
    sequence: z.number().int().nonnegative(),
    health: ObservedHealthSchema,
    state: JsonValueSchema,
    reportedAt: TimestampSchema,
  })
  .readonly();

export type OutputKind = z.infer<typeof OutputKindSchema>;
export type OutputTransport = z.infer<typeof OutputTransportSchema>;
export type ObservedHealth = z.infer<typeof ObservedHealthSchema>;
export type DesiredLifecycle = z.infer<typeof DesiredLifecycleSchema>;
export type CourtProgramProfile = z.infer<typeof CourtProgramProfileSchema>;
export type DesiredOutputSpec = z.infer<typeof DesiredOutputSpecSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type DesiredOutputState = z.infer<typeof DesiredOutputStateSchema>;
export type ObservedOutputState = z.infer<typeof ObservedOutputStateSchema>;
