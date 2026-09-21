import { z } from 'zod';
import { PilotCourtSlugSchema, PilotMobileCameraCapabilitiesSchema, PilotMobileCameraDesiredSchema } from '@kpl/production-contracts';

export const MobileSnapshotSchema = z.strictObject({
  version: z.literal(1),
  runtimeProcess: z.strictObject({ pid: z.number().int().min(2), startTime: z.string().regex(/^\d+$/), bootId: z.string().optional() }).nullable(),
  sessions: z.array(z.strictObject({
    id: z.uuid(), courtSlug: PilotCourtSlugSchema,
    tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(), desired: PilotMobileCameraDesiredSchema,
    capabilities: PilotMobileCameraCapabilitiesSchema.nullable(), clientId: z.uuid().nullable(), revoked: z.boolean(),
  })).superRefine((sessions, context) => {
    if (new Set(sessions.map(({ id }) => id)).size !== sessions.length
      || new Set(sessions.map(({ courtSlug }) => courtSlug)).size !== sessions.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate mobile identity' });
    }
  }),
});
