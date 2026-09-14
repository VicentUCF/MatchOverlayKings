import { buildFfmpegCommandPlan } from './ffmpeg-plan.js';
import {
  FfmpegCourtPipelineError,
  type FfmpegCourtPipelineOptions,
} from './ffmpeg-court-pipeline-model.js';
import type {
  AlsaAudioDescriptor,
  V4l2VideoDescriptor,
} from './media-runtime-config.js';
import type { PipelineTarget } from './models.js';
import type { ProcessCommandPlan } from './process-command-plan.js';

export type ResolvedFfmpegCourtPlan = {
  readonly command: ProcessCommandPlan;
  readonly pathName: string;
  readonly overlayFrames: AsyncIterable<Uint8Array> | null;
};

function findExactlyOne<Item>(
  items: readonly Item[],
  matches: (item: Item) => boolean,
): Item | null {
  const found = items.filter(matches);
  return found.length === 1 ? found[0] ?? null : null;
}

function resolveVideo(
  options: FfmpegCourtPipelineOptions,
  target: PipelineTarget,
): V4l2VideoDescriptor {
  const video = findExactlyOne(
    options.config.bindings.videoInputs,
    (candidate) => candidate.deviceId === target.desired.desired.profile.videoSourceDeviceId,
  );
  if (video === null) throw new FfmpegCourtPipelineError('INVALID_BINDING');
  return video;
}

function resolveAudio(
  options: FfmpegCourtPipelineOptions,
  target: PipelineTarget,
): AlsaAudioDescriptor | null {
  const deviceId = target.desired.desired.profile.audioSourceDeviceId;
  if (deviceId === null) return null;
  const audio = findExactlyOne(options.config.bindings.audioInputs, (candidate) => candidate.deviceId === deviceId);
  if (audio === null) throw new FfmpegCourtPipelineError('INVALID_BINDING');
  return audio;
}

export function resolveFfmpegCourtPlan(
  options: FfmpegCourtPipelineOptions,
  target: PipelineTarget,
): ResolvedFfmpegCourtPlan {
  const profile = target.desired.desired.profile;
  if (!target.output.enabled || target.output.kind !== 'program' || target.output.transport !== 'srt'
    || target.output.courtId !== options.courtId || profile.courtId !== options.courtId) {
    throw new FfmpegCourtPipelineError('INVALID_TARGET');
  }
  const path = findExactlyOne(
    options.config.bindings.courts,
    (candidate) => candidate.courtId === options.courtId,
  );
  if (path === null) throw new FfmpegCourtPipelineError('INVALID_BINDING');
  const video = resolveVideo(options, target);
  const audio = resolveAudio(options, target);
  const source = profile.overlayEnabled ? options.overlayFactory?.create(target) ?? null : null;
  if (profile.overlayEnabled && source === null) {
    throw new FfmpegCourtPipelineError('OVERLAY_UNAVAILABLE');
  }
  if (source !== null && (source.descriptor.width !== profile.width
    || source.descriptor.height !== profile.height
    || source.descriptor.framesPerSecond !== profile.framesPerSecond)) {
    throw new FfmpegCourtPipelineError('OVERLAY_UNAVAILABLE');
  }
  const command = buildFfmpegCommandPlan({
    executablePath: options.config.ffmpegExecutablePath,
    cwd: options.config.runtimeDirectoryPath,
    profile,
    video,
    audio,
    overlay: source?.descriptor ?? null,
    sink: {
      host: options.config.bindings.srtHost,
      port: options.config.bindings.srtPort,
      pathName: path.pathName,
    },
  });
  return Object.freeze({ command, pathName: path.pathName, overlayFrames: source?.frames ?? null });
}
