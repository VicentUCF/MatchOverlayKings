import { CourtIdSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { resolveFfmpegCourtPlan } from '../src/ffmpeg-court-plan.js';
import type {
  FfmpegCourtPipelineOptions,
  OverlayFrameSource,
  OverlayFrameSourceFactoryPort,
} from '../src/ffmpeg-court-pipeline-model.js';
import { LocalMediaRuntimeConfigSchema, OverlayInputDescriptorSchema } from '../src/media-runtime-config.js';
import { ProfileFingerprintSchema, ReconcileInputSchema, type PipelineTarget } from '../src/models.js';
import { AUDIO_DEVICE_ID, COURT_ID, VIDEO_DEVICE_ID, reconcileInput } from './fixtures.js';

const courtIds = [
  COURT_ID,
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004',
] as const;
const fixedCourtId = CourtIdSchema.parse(COURT_ID);

function mediaConfig() {
  return LocalMediaRuntimeConfigSchema.parse({
    courtIds,
    mediaMtxVersion: '1.21.0',
    mediaMtxExecutablePath: '/opt/kpl/bin/mediamtx',
    ffmpegExecutablePath: '/opt/kpl/bin/ffmpeg',
    runtimeDirectoryPath: '/run/user/1000/kpl-agent',
    runtimeDirectoryMode: 0o700,
    configFileMode: 0o600,
    persistence: 'ephemeral',
    startupTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    stopGraceMs: 2_000,
    bindings: {
      apiHost: '127.0.0.1', apiPort: 9997, srtHost: '127.0.0.1', srtPort: 8890,
      courts: courtIds.map((courtId, index) => ({ courtId, pathName: `court-${index + 1}` })),
      videoInputs: [{ deviceId: VIDEO_DEVICE_ID, kind: 'v4l2', devicePath: '/dev/video0', inputPixelFormat: 'yuyv422' }],
      audioInputs: [{ deviceId: AUDIO_DEVICE_ID, kind: 'alsa', deviceName: 'hw:1,0' }],
    },
  });
}

function target(overrides: {
  readonly output?: Readonly<Record<string, unknown>>;
  readonly profile?: Readonly<Record<string, unknown>>;
} = {}): PipelineTarget {
  const input = reconcileInput();
  const parsed = ReconcileInputSchema.parse({
    ...input,
    output: { ...input.output, ...overrides.output },
    desired: {
      ...input.desired,
      desired: {
        ...input.desired.desired,
        profile: { ...input.desired.desired.profile, ...overrides.profile },
      },
    },
  });
  return {
    output: parsed.output,
    desired: parsed.desired,
    profileFingerprint: ProfileFingerprintSchema.parse('a'.repeat(64)),
  };
}

function options(overlayFactory: OverlayFrameSourceFactoryPort | null = null) {
  let spawnCalls = 0;
  let inspectionCalls = 0;
  const value = {
    config: mediaConfig(),
    courtId: fixedCourtId,
    spawner: { spawn: async () => { spawnCalls += 1; throw new TypeError('Unexpected spawn'); } },
    scheduler: { wait: async () => undefined },
    clock: { nowMs: () => 10 },
    mediaInspector: {
      inspectPaths: async () => {
        inspectionCalls += 1;
        return Object.freeze({ itemCount: 0, pageCount: 0, items: Object.freeze([]) });
      },
    },
    overlayFactory,
  } satisfies FfmpegCourtPipelineOptions;
  return { value, spawnCalls: () => spawnCalls, inspectionCalls: () => inspectionCalls };
}

async function* frames(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1]);
}

function overlaySource(width = 1920): OverlayFrameSource {
  return Object.freeze({
    descriptor: OverlayInputDescriptorSchema.parse({
      fd: 4, pixelFormat: 'rgba', width, height: 1080, framesPerSecond: 60,
    }),
    frames: frames(),
  });
}

describe('FFmpeg fixed-court plan resolution', () => {
  it.each([
    ['disabled output', { enabled: false }],
    ['clean output', { kind: 'clean' }],
    ['RTMP output', { transport: 'rtmp' }],
  ])('rejects an invalid target for %s', (_label, output) => {
    const context = options();

    expect(() => resolveFfmpegCourtPlan(context.value, target({ output }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_TARGET' }),
    );
  });

  it('rejects an output for a different fixed court', () => {
    const context = options();
    const base = target();
    const mismatched = { ...base, output: { ...base.output, courtId: CourtIdSchema.parse(courtIds[1]) } };

    expect(() => resolveFfmpegCourtPlan(context.value, mismatched)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TARGET' }),
    );
  });

  it('rejects a profile for a different fixed court', () => {
    const context = options();
    const base = target();
    const mismatched = {
      ...base,
      desired: {
        ...base.desired,
        desired: {
          ...base.desired.desired,
          profile: { ...base.desired.desired.profile, courtId: CourtIdSchema.parse(courtIds[1]) },
        },
      },
    };

    expect(() => resolveFfmpegCourtPlan(context.value, mismatched)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TARGET' }),
    );
  });

  it('rejects missing or ambiguous court, video, and audio bindings', () => {
    const context = options();
    const config = context.value.config;
    const configuredTarget = target();
    const path = config.bindings.courts.find(({ courtId }) => courtId === fixedCourtId);
    if (path === undefined) throw new TypeError('Test fixture has no court binding');
    const video = config.bindings.videoInputs.find(({ deviceId }) => deviceId === configuredTarget.desired.desired.profile.videoSourceDeviceId);
    if (video === undefined) throw new TypeError('Test fixture has no video binding');
    const missingPath = { ...context.value, config: {
      ...config, bindings: { ...config.bindings, courts: config.bindings.courts.filter(({ courtId }) => courtId !== fixedCourtId) },
    } };
    const duplicatePath = { ...context.value, config: {
      ...config, bindings: { ...config.bindings, courts: [...config.bindings.courts, path] },
    } };
    const missingVideo = { ...context.value, config: {
      ...config, bindings: { ...config.bindings, videoInputs: [] },
    } };
    const duplicateVideo = { ...context.value, config: {
      ...config, bindings: { ...config.bindings, videoInputs: [...config.bindings.videoInputs, video] },
    } };
    const missingAudio = { ...context.value, config: {
      ...config, bindings: { ...config.bindings, audioInputs: [] },
    } };

    expect(() => resolveFfmpegCourtPlan(missingPath, configuredTarget)).toThrowError(expect.objectContaining({ code: 'INVALID_BINDING' }));
    expect(() => resolveFfmpegCourtPlan(duplicatePath, configuredTarget)).toThrowError(expect.objectContaining({ code: 'INVALID_BINDING' }));
    expect(() => resolveFfmpegCourtPlan(missingVideo, configuredTarget)).toThrowError(expect.objectContaining({ code: 'INVALID_BINDING' }));
    expect(() => resolveFfmpegCourtPlan(duplicateVideo, configuredTarget)).toThrowError(expect.objectContaining({ code: 'INVALID_BINDING' }));
    expect(() => resolveFfmpegCourtPlan(missingAudio, configuredTarget)).toThrowError(expect.objectContaining({ code: 'INVALID_BINDING' }));
  });

  it('builds one video-only path without overlay source activity', () => {
    const context = options();

    const resolved = resolveFfmpegCourtPlan(context.value, target({ profile: {
      audioSourceDeviceId: null, overlayEnabled: false,
    } }));

    expect(resolved.pathName).toBe('court-1');
    expect(resolved.overlayFrames).toBeNull();
    expect(resolved.command.argv).toContain('srt://127.0.0.1:8890?streamid=publish:court-1');
    expect(resolved.command.stdio).toEqual(['ignore', 'ignore', 'pipe', 'pipe', 'ignore']);
    expect(context.spawnCalls()).toBe(0);
    expect(context.inspectionCalls()).toBe(0);
  });

  it('maps unavailable and mismatched overlay sources before any process activity', () => {
    const unavailable = options();
    const absent = options({ create: () => null });
    const mismatch = options({ create: () => overlaySource(1280) });

    expect(() => resolveFfmpegCourtPlan(unavailable.value, target())).toThrowError(expect.objectContaining({ code: 'OVERLAY_UNAVAILABLE' }));
    expect(() => resolveFfmpegCourtPlan(absent.value, target())).toThrowError(expect.objectContaining({ code: 'OVERLAY_UNAVAILABLE' }));
    expect(() => resolveFfmpegCourtPlan(mismatch.value, target())).toThrowError(expect.objectContaining({ code: 'OVERLAY_UNAVAILABLE' }));
    expect(unavailable.spawnCalls() + absent.spawnCalls() + mismatch.spawnCalls()).toBe(0);
  });

  it('delegates an overlay plan with progress fd3 and frame fd4', () => {
    const source = overlaySource();
    const context = options({ create: () => source });

    const resolved = resolveFfmpegCourtPlan(context.value, target());

    expect(resolved.overlayFrames).toBe(source.frames);
    expect(resolved.command.argv).toContain('pipe:3');
    expect(resolved.command.argv).toContain('pipe:4');
    expect(resolved.command.stdio).toEqual(['ignore', 'ignore', 'pipe', 'pipe', 'pipe']);
    expect(context.spawnCalls()).toBe(0);
    expect(context.inspectionCalls()).toBe(0);
  });
});
