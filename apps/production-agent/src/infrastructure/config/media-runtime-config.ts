import { isAbsolute } from 'node:path';
import { CourtIdSchema, DeviceIdSchema } from '@kpl/production-contracts';
import { z } from 'zod';

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute);
const PathNameSchema = z.string().regex(/^[a-z0-9-]+$/).min(1).max(64);
const LoopbackHostSchema = z.literal('127.0.0.1');
const PortSchema = z.number().int().min(1024).max(65_535);
const TimeoutSchema = z.number().int().min(100).max(120_000);

export const V4l2VideoDescriptorSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  kind: z.literal('v4l2'),
  devicePath: AbsolutePathSchema.refine((path) => path.startsWith('/dev/')),
  inputPixelFormat: z.enum(['yuyv422', 'mjpeg']),
}).readonly();

export const AlsaAudioDescriptorSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  kind: z.literal('alsa'),
  deviceName: z.string().regex(/^[A-Za-z0-9:,_-]+$/).min(1).max(128),
}).readonly();

export const OverlayInputDescriptorSchema = z.strictObject({
  fd: z.literal(4),
  pixelFormat: z.enum(['rgba', 'bgra']),
  width: z.number().int().min(640).max(7680),
  height: z.number().int().min(360).max(4320),
  framesPerSecond: z.number().int().min(24).max(120),
}).readonly();

export const LocalSrtProgramSinkSchema = z.strictObject({
  host: LoopbackHostSchema,
  port: PortSchema,
  pathName: PathNameSchema,
}).readonly();

const CourtPathBindingSchema = z.strictObject({
  courtId: CourtIdSchema,
  pathName: PathNameSchema,
}).readonly();

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const LocalMediaBindingsSchema = z.strictObject({
  apiHost: LoopbackHostSchema,
  apiPort: PortSchema,
  srtHost: LoopbackHostSchema,
  srtPort: PortSchema,
  courts: CourtPathBindingSchema.array().length(4).readonly(),
  videoInputs: V4l2VideoDescriptorSchema.array().min(1).readonly(),
  audioInputs: AlsaAudioDescriptorSchema.array().readonly(),
}).superRefine((bindings, context) => {
  const uniqueGroups = [
    bindings.courts.map(({ courtId }) => courtId),
    bindings.courts.map(({ pathName }) => pathName),
    bindings.videoInputs.map(({ deviceId }) => deviceId),
    bindings.audioInputs.map(({ deviceId }) => deviceId),
  ];
  if (uniqueGroups.some((values) => !hasUniqueValues(values))) {
    context.addIssue({ code: 'custom', message: 'Media bindings must be unique' });
  }
}).readonly();

export const LocalMediaRuntimeConfigSchema = z.strictObject({
  courtIds: CourtIdSchema.array().length(4).readonly(),
  mediaMtxVersion: z.literal('1.21.0'),
  mediaMtxExecutablePath: AbsolutePathSchema,
  ffmpegExecutablePath: AbsolutePathSchema,
  runtimeDirectoryPath: AbsolutePathSchema,
  runtimeDirectoryMode: z.literal(0o700),
  configFileMode: z.literal(0o600),
  persistence: z.literal('ephemeral'),
  startupTimeoutMs: TimeoutSchema,
  healthTimeoutMs: TimeoutSchema,
  stopGraceMs: z.number().int().min(100).max(30_000),
  bindings: LocalMediaBindingsSchema,
}).superRefine((config, context) => {
  const configuredCourts = new Set(config.courtIds);
  const boundCourts = new Set(config.bindings.courts.map(({ courtId }) => courtId));
  if (configuredCourts.size !== 4 || boundCourts.size !== 4
    || config.courtIds.some((courtId) => !boundCourts.has(courtId))) {
    context.addIssue({ code: 'custom', message: 'Court bindings must match configured courts' });
  }
}).readonly();

export type LocalMediaRuntimeConfig = z.infer<typeof LocalMediaRuntimeConfigSchema>;
export type V4l2VideoDescriptor = z.infer<typeof V4l2VideoDescriptorSchema>;
export type AlsaAudioDescriptor = z.infer<typeof AlsaAudioDescriptorSchema>;
export type OverlayInputDescriptor = z.infer<typeof OverlayInputDescriptorSchema>;
export type LocalSrtProgramSink = z.infer<typeof LocalSrtProgramSinkSchema>;
