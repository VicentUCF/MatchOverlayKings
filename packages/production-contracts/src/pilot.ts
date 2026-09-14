import { z } from 'zod';

export const PilotCourtSlugSchema = z.enum(['pista-1', 'pista-2', 'pista-3']);
export const PilotModeSchema = z.enum(['simulation', 'youtube']);
export const PilotPrivacySchema = z.enum(['private', 'unlisted', 'public']);
export const PilotSessionStatusSchema = z.enum([
  'prepared',
  'starting',
  'live',
  'stopping',
  'stopped',
  'failed',
]);

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
]);

export const PilotReadinessSchema = z.strictObject({
  ffmpeg: z.strictObject({
    available: z.boolean(),
    version: z.string().nullable(),
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
  scheduledAt: z.iso.datetime({ offset: true }),
  privacyStatus: PilotPrivacySchema,
});

export const PilotEncoderHealthSchema = z.strictObject({
  frame: z.number().int().nonnegative(),
  framesPerSecond: z.number().nonnegative(),
  bitrateKbps: z.number().nonnegative(),
  speed: z.number().nonnegative(),
});

export const PilotSessionSchema = z.strictObject({
  id: z.uuid(),
  courtSlug: PilotCourtSlugSchema,
  mode: PilotModeSchema,
  source: PilotSourceSchema,
  status: PilotSessionStatusSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  thumbnailUrl: z.string().min(1),
  broadcastId: z.string().nullable(),
  watchUrl: z.string().url().nullable(),
  youtubeStreamStatus: z.string().nullable(),
  encoder: PilotEncoderHealthSchema.nullable(),
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
export type PilotEncoderHealth = z.infer<typeof PilotEncoderHealthSchema>;
export type PilotSession = z.infer<typeof PilotSessionSchema>;
