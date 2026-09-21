import { z } from 'zod';
import { PilotCourtSlugSchema } from './pilot.js';

export const RecordingAssetStateSchema = z.enum(['recording', 'validating', 'ready', 'invalid']);
const RecordingAssetIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PublicationTitleSchema = z.string().trim().min(1).max(100);
const PublicationDescriptionSchema = z.string().max(5_000);
export const RecordingStreamSchema = z.strictObject({
  kind: z.enum(['video', 'audio']),
  codec: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).readonly();

export const RecordingAssetSchema = z.strictObject({
  id: RecordingAssetIdSchema,
  sessionId: z.uuid(),
  courtSlug: PilotCourtSlugSchema,
  title: z.string().min(1),
  seasonLabel: z.string().min(1).max(32),
  matchdayNumber: z.number().int().positive().max(999),
  path: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  finalizedAt: z.iso.datetime({ offset: true }).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  streams: z.array(RecordingStreamSchema).readonly(),
  state: RecordingAssetStateSchema,
  error: z.string().max(500).nullable(),
}).readonly();
export const RecordingAssetsSchema = z.array(RecordingAssetSchema).readonly();

export const PublicationJobStateSchema = z.enum([
  'uploading', 'paused', 'processing', 'private_ready', 'scheduled', 'published', 'failed',
]);
export const PublicationJobSchema = z.strictObject({
  id: z.uuid(),
  assetId: RecordingAssetIdSchema,
  state: PublicationJobStateSchema,
  title: PublicationTitleSchema,
  description: PublicationDescriptionSchema,
  uploadUrl: z.string().url().nullable(),
  uploadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  youtubeVideoId: z.string().min(1).max(128).nullable(),
  watchUrl: z.string().url().nullable(),
  publishAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  error: z.string().max(500).nullable(),
}).readonly();
export const PublicationJobsSchema = z.array(PublicationJobSchema).readonly();

export const CreatePublicationJobInputSchema = z.strictObject({
  title: PublicationTitleSchema,
  description: PublicationDescriptionSchema,
}).readonly();
export const SchedulePublicationInputSchema = z.strictObject({
  publishAt: z.iso.datetime({ offset: true }),
}).readonly();

export type RecordingAssetState = z.infer<typeof RecordingAssetStateSchema>;
export type RecordingStream = z.infer<typeof RecordingStreamSchema>;
export type RecordingAsset = z.infer<typeof RecordingAssetSchema>;
export type PublicationJobState = z.infer<typeof PublicationJobStateSchema>;
export type PublicationJob = z.infer<typeof PublicationJobSchema>;
export type CreatePublicationJobInput = z.infer<typeof CreatePublicationJobInputSchema>;
export type SchedulePublicationInput = z.infer<typeof SchedulePublicationInputSchema>;
