import { z } from 'zod';

export const PilotPreflightCheckIdSchema = z.enum([
  'configuration', 'camera', 'profile', 'audio', 'storage', 'cpu', 'memory',
  'encoder', 'network', 'bitrate', 'mediamtx', 'overlay', 'authorization', 'destination',
]);
export const PilotPreflightCheckSchema = z.strictObject({
  id: PilotPreflightCheckIdSchema,
  label: z.string().min(1).max(80),
  status: z.enum(['pending', 'running', 'pass', 'warning', 'blocked', 'not_applicable']),
  message: z.string().max(500),
  checkedAt: z.iso.datetime().nullable(),
}).readonly();
export const PilotPreflightSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['running', 'ready', 'warning', 'blocked', 'stale', 'cancelled']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  checks: z.array(PilotPreflightCheckSchema).max(14).readonly(),
  preview: z.strictObject({
    url: z.string().startsWith('/api/pilot/sessions/'),
    durationSeconds: z.number().positive().max(30),
    sizeBytes: z.number().int().positive(),
  }).nullable(),
}).readonly();
export const RunPilotPreflightInputSchema = z.strictObject({ check: PilotPreflightCheckIdSchema.optional() });
export type PilotPreflightCheckId = z.infer<typeof PilotPreflightCheckIdSchema>;
export type PilotPreflightCheck = z.infer<typeof PilotPreflightCheckSchema>;
export type PilotPreflight = z.infer<typeof PilotPreflightSchema>;
