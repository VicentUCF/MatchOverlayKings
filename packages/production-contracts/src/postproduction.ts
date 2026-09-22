import { z } from 'zod';
import { JsonValueSchema } from './common.js';
import { PilotCourtSlugSchema } from './pilot.js';

export const PostproductionProjectStatusSchema = z.enum(['editing', 'rendering', 'ready', 'failed']);
export const PostproductionActionKindSchema = z.enum([
  'add_point', 'undo', 'reset', 'manual_patch', 'update_meta', 'set_status',
  'update_overlay', 'use_card', 'trigger_data_scene', 'update_sponsor_ticker', 'trigger_sponsor_ad',
]);
export const PostproductionActionSchema = z.strictObject({
  id: z.uuid(),
  timestampMs: z.number().int().nonnegative(),
  kind: PostproductionActionKindSchema,
  payload: JsonValueSchema,
}).readonly();
export const PostproductionActionsSchema = z.array(PostproductionActionSchema).readonly();

export const PostproductionSourceSchema = z.strictObject({
  relativePath: z.string().min(1).max(4_096),
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  modifiedAt: z.iso.datetime({ offset: true }),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  durationSeconds: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  framesPerSecond: z.union([z.literal(30), z.literal(60)]),
  hasAudio: z.boolean(),
}).readonly();

export const PostproductionCheckpointSchema = z.strictObject({
  playheadMs: z.number().int().nonnegative(),
  actions: PostproductionActionsSchema,
  state: JsonValueSchema,
  reason: z.enum(['initial', 'game', 'manual', 'recount']),
  savedAt: z.iso.datetime({ offset: true }),
}).readonly();

export const PostproductionRenderSchema = z.strictObject({
  progress: z.number().min(0).max(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  outputAssetId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  error: z.string().max(500).nullable(),
}).readonly();

export const PostproductionProjectSchema = z.strictObject({
  id: z.uuid(),
  status: PostproductionProjectStatusSchema,
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  seasonLabel: z.string().trim().min(1).max(32),
  matchdayNumber: z.number().int().positive().max(999),
  courtSlug: PilotCourtSlugSchema,
  source: PostproductionSourceSchema,
  initialState: JsonValueSchema,
  teams: JsonValueSchema,
  leagueSnapshot: JsonValueSchema.nullable(),
  checkpoint: PostproductionCheckpointSchema,
  render: PostproductionRenderSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).readonly();
export const PostproductionProjectsSchema = z.array(PostproductionProjectSchema).readonly();

export const PostproductionSourceListingSchema = z.strictObject({
  current: z.string(),
  parent: z.string().nullable(),
  directories: z.array(z.strictObject({ name: z.string(), path: z.string() }).readonly()).readonly(),
  files: z.array(z.strictObject({ name: z.string(), path: z.string(), sizeBytes: z.number().int().nonnegative() }).readonly()).readonly(),
}).readonly();

export const CreatePostproductionProjectInputSchema = z.strictObject({
  sourcePath: z.string().min(1).max(4_096),
  title: z.string().trim().min(1).max(200),
  seasonLabel: z.string().trim().min(1).max(32),
  matchdayNumber: z.number().int().positive().max(999),
  courtSlug: PilotCourtSlugSchema,
  initialState: JsonValueSchema,
  teams: JsonValueSchema,
  leagueSnapshot: JsonValueSchema.nullable().optional(),
}).readonly();

export const SavePostproductionCheckpointInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  playheadMs: z.number().int().nonnegative(),
  actions: PostproductionActionsSchema,
  reason: z.enum(['game', 'manual', 'recount']),
}).readonly();

export const RelinkPostproductionSourceInputSchema = z.strictObject({
  sourcePath: z.string().min(1).max(4_096),
}).readonly();

export const PostproductionOperatorAccessSchema = z.strictObject({
  controlUrl: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
}).readonly();

export const PostproductionPlayheadInputSchema = z.strictObject({
  playheadMs: z.number().int().nonnegative(),
}).readonly();

export const PostproductionControlCommandInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  commandId: z.uuid(),
  kind: PostproductionActionKindSchema,
  payload: JsonValueSchema,
}).readonly();

export const PostproductionControlSnapshotSchema = z.strictObject({
  projectId: z.uuid(),
  state: JsonValueSchema,
  teams: JsonValueSchema,
  playheadMs: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
}).readonly();

export type PostproductionProjectStatus = z.infer<typeof PostproductionProjectStatusSchema>;
export type PostproductionActionKind = z.infer<typeof PostproductionActionKindSchema>;
export type PostproductionAction = z.infer<typeof PostproductionActionSchema>;
export type PostproductionSource = z.infer<typeof PostproductionSourceSchema>;
export type PostproductionCheckpoint = z.infer<typeof PostproductionCheckpointSchema>;
export type PostproductionRender = z.infer<typeof PostproductionRenderSchema>;
export type PostproductionProject = z.infer<typeof PostproductionProjectSchema>;
export type PostproductionSourceListing = z.infer<typeof PostproductionSourceListingSchema>;
export type CreatePostproductionProjectInput = z.infer<typeof CreatePostproductionProjectInputSchema>;
export type SavePostproductionCheckpointInput = z.infer<typeof SavePostproductionCheckpointInputSchema>;
export type RelinkPostproductionSourceInput = z.infer<typeof RelinkPostproductionSourceInputSchema>;
export type PostproductionOperatorAccess = z.infer<typeof PostproductionOperatorAccessSchema>;
export type PostproductionPlayheadInput = z.infer<typeof PostproductionPlayheadInputSchema>;
export type PostproductionControlCommandInput = z.infer<typeof PostproductionControlCommandInputSchema>;
export type PostproductionControlSnapshot = z.infer<typeof PostproductionControlSnapshotSchema>;
