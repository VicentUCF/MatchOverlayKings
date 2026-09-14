import { isAbsolute } from 'node:path';
import { CourtProgramProfileSchema } from '@kpl/production-contracts';
import { z } from 'zod';
import {
  AlsaAudioDescriptorSchema,
  LocalSrtProgramSinkSchema,
  OverlayInputDescriptorSchema,
  V4l2VideoDescriptorSchema,
} from './media-runtime-config.js';
import {
  MEDIA_PROCESS_ENV,
  type ProcessCommandPlan,
  type ProcessStdioPlan,
} from './process-command-plan.js';

const FfmpegPlanInputSchema = z.strictObject({
  executablePath: z.string().refine(isAbsolute),
  cwd: z.string().refine(isAbsolute),
  profile: CourtProgramProfileSchema,
  video: V4l2VideoDescriptorSchema,
  audio: AlsaAudioDescriptorSchema.nullable(),
  overlay: OverlayInputDescriptorSchema.nullable(),
  sink: LocalSrtProgramSinkSchema,
});

export type FfmpegPlanInput = z.input<typeof FfmpegPlanInputSchema>;

export function buildFfmpegCommandPlan(input: FfmpegPlanInput): ProcessCommandPlan {
  const parsed = FfmpegPlanInputSchema.parse(input);
  const { profile, video, audio, overlay, sink } = parsed;
  if (video.deviceId !== profile.videoSourceDeviceId) throw new TypeError('Video binding mismatch');
  if ((audio?.deviceId ?? null) !== profile.audioSourceDeviceId) {
    throw new TypeError('Audio binding mismatch');
  }
  if (profile.overlayEnabled !== (overlay !== null)) throw new TypeError('Overlay binding mismatch');
  if (overlay !== null && (overlay.width !== profile.width || overlay.height !== profile.height
    || overlay.framesPerSecond !== profile.framesPerSecond)) {
    throw new TypeError('Overlay format mismatch');
  }

  const dimensions = `${profile.width}x${profile.height}`;
  const argv: string[] = [
    '-nostdin', '-nostats', '-loglevel', 'warning', '-progress', 'pipe:3', '-stats_period', '1',
    '-f', 'v4l2', '-input_format', video.inputPixelFormat, '-framerate', `${profile.framesPerSecond}`,
    '-video_size', dimensions, '-i', video.devicePath,
  ];
  if (audio !== null) argv.push('-f', 'alsa', '-i', audio.deviceName);
  if (overlay !== null) {
    argv.push(
      '-f', 'rawvideo', '-pixel_format', overlay.pixelFormat, '-video_size', dimensions,
      '-framerate', `${overlay.framesPerSecond}`, '-i', 'pipe:4',
      '-filter_complex', `[0:v][${audio === null ? 1 : 2}:v]overlay=0:0[vout]`, '-map', '[vout]',
    );
  } else argv.push('-map', '0:v:0');
  if (audio !== null) argv.push('-map', '1:a:0');
  argv.push(
    '-c:v', 'libx264', '-b:v', `${profile.videoBitrateKbps}k`, '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
  );
  if (audio === null) argv.push('-an');
  else argv.push('-c:a', 'aac', '-b:a', `${profile.audioBitrateKbps}k`);
  argv.push('-f', 'mpegts', `srt://${sink.host}:${sink.port}?streamid=publish:${sink.pathName}`);
  const stdio: readonly ProcessStdioPlan[] = Object.freeze([
    'ignore', 'ignore', 'pipe', 'pipe', overlay === null ? 'ignore' : 'pipe',
  ]);

  return Object.freeze({
    executable: parsed.executablePath,
    argv: Object.freeze(argv),
    cwd: parsed.cwd,
    env: MEDIA_PROCESS_ENV,
    stdio,
    shell: false,
  });
}
