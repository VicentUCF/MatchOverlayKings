import { z } from 'zod';
import { PilotSignalHealthSchema } from './pilot-signal.js';
import { PilotPreflightSchema } from './pilot-preflight.js';

// Kept as a compatibility name while the former pilot becomes the production
// runtime. Court inventory is authoritative in Supabase, so slugs cannot be an
// application-level fixed enum.
export const PilotCourtSlugSchema = z.string().regex(/^pista-[a-z0-9-]+$/).max(80);
export const PilotModeSchema = z.enum(['simulation', 'youtube', 'recording']);
export const PilotPrivacySchema = z.enum(['private', 'unlisted', 'public']);
export const PilotSessionStatusSchema = z.enum([
  'preparing',
  'prepared',
  'starting',
  'live',
  'reconnecting',
  'interrupted',
  'stopping',
  'stopped',
  'failed',
]);

export const PILOT_MOBILE_SOURCE_ID = 'mobile:pilot' as const;
export const PilotMobileVideoProfileSchema = z.enum([
  '720p30',
  '720p60',
  '1080p30',
  '1080p60',
]);
export const PilotMobileCameraStateSchema = z.enum([
  'waiting_permission',
  'connecting',
  'ready',
  'reconnecting',
  'degraded',
  'offline',
  'error',
  'revoked',
]);

export const PilotMobileCameraCapabilitySchema = z.strictObject({
  id: z.string().min(1).max(512),
  label: z.string().trim().min(1).max(160),
  facingMode: z.enum(['user', 'environment', 'unknown']),
  maxWidth: z.number().int().positive().max(7680).nullable(),
  maxHeight: z.number().int().positive().max(4320).nullable(),
  maxFramesPerSecond: z.number().positive().max(240).nullable(),
  supportedProfiles: z.array(PilotMobileVideoProfileSchema).readonly(),
}).readonly();

export const PilotMobileCameraCapabilitiesSchema = z.strictObject({
  cameras: z.array(PilotMobileCameraCapabilitySchema).min(1).readonly(),
  audioAvailable: z.boolean(),
}).readonly();

export const PilotMobileCameraDesiredSchema = z.strictObject({
  revision: z.number().int().positive(),
  cameraId: z.string().min(1).max(512).nullable(),
  profile: PilotMobileVideoProfileSchema,
  audioEnabled: z.boolean(),
}).readonly();

export const PilotMobileCameraAppliedSchema = z.strictObject({
  revision: z.number().int().positive(),
  cameraId: z.string().min(1).max(512),
  profile: PilotMobileVideoProfileSchema,
  audioEnabled: z.boolean(),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  framesPerSecond: z.number().nonnegative().max(240),
}).readonly();

export const PilotMobileCameraMetricsSchema = z.strictObject({
  bitrateKbps: z.number().nonnegative(),
  packetLossPercent: z.number().min(0).max(100).nullable(),
  roundTripTimeMs: z.number().nonnegative().nullable(),
}).readonly();

export const PilotMobileCameraStatusReportSchema = z.strictObject({
  clientId: z.uuid(),
  state: PilotMobileCameraStateSchema.exclude(['waiting_permission', 'offline', 'revoked']),
  applied: PilotMobileCameraAppliedSchema.nullable(),
  metrics: PilotMobileCameraMetricsSchema.nullable(),
  error: z.string().trim().min(1).max(500).nullable(),
}).readonly();

export const PilotMobileCameraSessionSchema = z.strictObject({
  id: z.uuid(),
  courtSlug: PilotCourtSlugSchema,
  state: PilotMobileCameraStateSchema,
  desired: PilotMobileCameraDesiredSchema,
  capabilities: PilotMobileCameraCapabilitiesSchema.nullable(),
  applied: PilotMobileCameraAppliedSchema.nullable(),
  metrics: PilotMobileCameraMetricsSchema.nullable(),
  claimed: z.boolean(),
  lastHeartbeatAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  error: z.string().max(500).nullable(),
  previewUrl: z.string().url().nullable(),
}).readonly();

export const CreatePilotMobileCameraInputSchema = z.strictObject({
  courtSlug: PilotCourtSlugSchema,
}).readonly();

export const PilotMobileCameraLinkSchema = z.strictObject({
  session: PilotMobileCameraSessionSchema,
  connectUrl: z.string().url(),
}).readonly();

export const ClaimPilotMobileCameraInputSchema = z.strictObject({
  clientId: z.uuid(),
  capabilities: PilotMobileCameraCapabilitiesSchema,
}).readonly();

export const ClaimPilotMobileCameraResponseSchema = z.strictObject({
  desired: PilotMobileCameraDesiredSchema,
  whipUrl: z.string().url(),
  whipUser: z.string().min(1).max(64),
}).readonly();

export const UpdatePilotMobileCameraDesiredInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  cameraId: z.string().min(1).max(512),
  profile: PilotMobileVideoProfileSchema,
  audioEnabled: z.boolean(),
}).readonly();

export const PilotSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.literal('synthetic'),
    kind: z.literal('synthetic'),
    label: z.string().min(1),
  }),
  z.strictObject({
    id: z.string().regex(/^v4l2:\/dev\/video\d+$/),
    kind: z.literal('v4l2'),
    label: z.string().min(1),
    devicePath: z.string().regex(/^\/dev\/video\d+$/),
  }),
  z.strictObject({
    id: z.literal(PILOT_MOBILE_SOURCE_ID),
    kind: z.literal('mobile'),
    label: z.string().min(1),
  }),
]);

export const PilotVideoEncoderSchema = z.strictObject({
  name: z.enum(['libx264', 'h264_nvenc', 'h264_amf', 'h264_vaapi', 'h264_qsv']),
  label: z.string().min(1),
  hardware: z.boolean(),
  device: z.string().nullable(),
  frameRates: z.array(z.union([z.literal(30), z.literal(60)])),
});

export const PilotReadinessSchema = z.strictObject({
  ffmpeg: z.strictObject({
    available: z.boolean(),
    version: z.string().nullable(),
    encoders: z.array(PilotVideoEncoderSchema).optional(),
  }),
  youtube: z.strictObject({
    configured: z.boolean(),
    authorized: z.boolean(),
    authorizationUrl: z.string().min(1).nullable(),
  }),
  sources: z.array(PilotSourceSchema).readonly(),
  limitations: z.array(z.string()).readonly(),
});

export const PreparePilotSessionInputSchema = z.strictObject({
  courtSlug: PilotCourtSlugSchema,
  mode: PilotModeSchema,
  sourceId: z.string().min(1).max(160),
  homeTeam: z.string().trim().min(1).max(80),
  awayTeam: z.string().trim().min(1).max(80),
  matchdayNumber: z.number().int().positive().max(999),
  seasonLabel: z.string().trim().min(1).max(32),
  description: z.string().trim().min(1).max(5_000).optional(),
  recordingDirectory: z.string().trim().min(1).max(4_096).optional(),
  scheduledAt: z.iso.datetime({ offset: true }),
  privacyStatus: PilotPrivacySchema,
});

const PilotCommonPlanSchema = PreparePilotSessionInputSchema.omit({
  mode: true,
  scheduledAt: true,
  privacyStatus: true,
  description: true,
  recordingDirectory: true,
});
export const RecordingPlanSchema = PilotCommonPlanSchema.extend({
  kind: z.literal('recording'),
  recordingDirectory: z.string().trim().min(1).max(4_096),
});
export const LivePlanSchema = PilotCommonPlanSchema.extend({
  kind: z.literal('live'),
  scheduledAt: PreparePilotSessionInputSchema.shape.scheduledAt,
  privacyStatus: PilotPrivacySchema,
  description: z.string().trim().min(1).max(5_000),
});
export const ProductionPlanSchema = z.discriminatedUnion('kind', [RecordingPlanSchema, LivePlanSchema]);

export const PilotConfigurationSchema = PreparePilotSessionInputSchema.extend({
  updatedAt: z.iso.datetime({ offset: true }),
});

export const PilotConfigurationsSchema = z.array(PilotConfigurationSchema).readonly();

export const PilotEncoderHealthSchema = z.strictObject({
  frame: z.number().int().nonnegative(),
  framesPerSecond: z.number().nonnegative(),
  bitrateKbps: z.number().nonnegative(),
  speed: z.number().nonnegative(),
});

export const PilotOverlayHealthSchema = z.strictObject({
  status: z.enum(['starting', 'ready', 'recovering', 'failed']),
  attempt: z.number().int().nonnegative().max(5),
  lastFrameAt: z.iso.datetime().nullable(),
  holdingLastFrame: z.boolean(),
  reason: z.string().max(300).nullable(),
}).readonly();
export type PilotOverlayHealth = z.infer<typeof PilotOverlayHealthSchema>;

export const PilotSessionSchema = z.strictObject({
  id: z.uuid(),
  courtSlug: PilotCourtSlugSchema,
  mode: PilotModeSchema,
  source: PilotSourceSchema,
  status: PilotSessionStatusSchema,
  preparationPending: z.boolean().optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  thumbnailUrl: z.string().min(1),
  broadcastId: z.string().nullable(),
  watchUrl: z.string().url().nullable(),
  youtubeStreamStatus: z.string().nullable(),
  recordingFiles: z.array(z.string().min(1)).optional(),
  encoder: PilotEncoderHealthSchema.nullable(),
  signal: PilotSignalHealthSchema.nullable().optional(),
  overlayHealth: PilotOverlayHealthSchema.nullable().optional(),
  preflight: PilotPreflightSchema.nullable().optional(),
  continuity: z.strictObject({ active: z.boolean(), attempt: z.number().int().nonnegative().max(5),
    exhausted: z.boolean(), reason: z.string().max(300).nullable() }).nullable().optional(),
  videoEncoding: PilotVideoEncoderSchema.nullable().optional(),
  encodingWarning: z.string().nullable().optional(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  stoppedAt: z.iso.datetime({ offset: true }).nullable(),
  error: z.string().nullable(),
});

export const PilotSessionsSchema = z.array(PilotSessionSchema).readonly();

export type PilotCourtSlug = z.infer<typeof PilotCourtSlugSchema>;
export type PilotMode = z.infer<typeof PilotModeSchema>;
export type PilotPrivacy = z.infer<typeof PilotPrivacySchema>;
export type PilotSource = z.infer<typeof PilotSourceSchema>;
export type PilotReadiness = z.infer<typeof PilotReadinessSchema>;
export type PreparePilotSessionInput = z.infer<typeof PreparePilotSessionInputSchema>;
export type RecordingPlan = z.infer<typeof RecordingPlanSchema>;
export type LivePlan = z.infer<typeof LivePlanSchema>;
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;
export type PilotConfiguration = z.infer<typeof PilotConfigurationSchema>;
export type PilotEncoderHealth = z.infer<typeof PilotEncoderHealthSchema>;
export type PilotVideoEncoder = z.infer<typeof PilotVideoEncoderSchema>;
export type PilotSession = z.infer<typeof PilotSessionSchema>;
export type PilotMobileVideoProfile = z.infer<typeof PilotMobileVideoProfileSchema>;
export type PilotMobileCameraState = z.infer<typeof PilotMobileCameraStateSchema>;
export type PilotMobileCameraCapability = z.infer<typeof PilotMobileCameraCapabilitySchema>;
export type PilotMobileCameraCapabilities = z.infer<typeof PilotMobileCameraCapabilitiesSchema>;
export type PilotMobileCameraDesired = z.infer<typeof PilotMobileCameraDesiredSchema>;
export type PilotMobileCameraApplied = z.infer<typeof PilotMobileCameraAppliedSchema>;
export type PilotMobileCameraMetrics = z.infer<typeof PilotMobileCameraMetricsSchema>;
export type PilotMobileCameraStatusReport = z.infer<typeof PilotMobileCameraStatusReportSchema>;
export type PilotMobileCameraSession = z.infer<typeof PilotMobileCameraSessionSchema>;
export type PilotMobileCameraLink = z.infer<typeof PilotMobileCameraLinkSchema>;
export type ClaimPilotMobileCameraResponse = z.infer<typeof ClaimPilotMobileCameraResponseSchema>;
export type UpdatePilotMobileCameraDesiredInput = z.infer<typeof UpdatePilotMobileCameraDesiredInputSchema>;
