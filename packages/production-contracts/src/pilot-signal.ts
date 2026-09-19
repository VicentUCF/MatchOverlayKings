import { z } from 'zod';

export const PilotSignalIssueCodeSchema = z.enum(['black_video', 'frozen_video', 'silent_audio', 'video_missing', 'low_fps', 'slow_encoder', 'dropped_frames', 'low_bitrate']);
export const PilotSignalIssueSchema = z.strictObject({
  code: PilotSignalIssueCodeSchema,
  since: z.iso.datetime(),
  message: z.string().max(300),
}).readonly();
export const PilotSignalHealthSchema = z.strictObject({
  sampledAt: z.iso.datetime(),
  checking: z.boolean(),
  lastVideoSampleAt: z.iso.datetime().nullable(),
  audioExpected: z.boolean(),
  measuredFramesPerSecond: z.number().nonnegative().nullable(),
  measuredSpeed: z.number().nonnegative().nullable(),
  measuredBitrateKbps: z.number().nonnegative().nullable(),
  droppedFrameRatio: z.number().min(0).max(1).nullable(),
  issues: z.array(PilotSignalIssueSchema).readonly(),
}).readonly();
export type PilotSignalIssueCode = z.infer<typeof PilotSignalIssueCodeSchema>;
export type PilotSignalHealth = z.infer<typeof PilotSignalHealthSchema>;
