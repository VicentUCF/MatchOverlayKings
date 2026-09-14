import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  LocalMediaRuntimeConfigSchema,
  buildFfmpegCommandPlan,
  buildMediaMtxPlan,
} from '../src/index.js';
import { AUDIO_DEVICE_ID, COURT_ID, VIDEO_DEVICE_ID, profile } from './fixtures.js';

const courtIds = [
  COURT_ID,
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004',
] as const;

const apiUser = {
  username: 'kpl-control-api',
  passwordHash: 'sha256:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
} as const;
const clearPasswordSentinel = 'CLEAR_PASSWORD_SENTINEL';

function mediaConfig() {
  return {
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
      apiHost: '127.0.0.1',
      apiPort: 9997,
      srtHost: '127.0.0.1',
      srtPort: 8890,
      courts: courtIds.map((courtId, index) => ({ courtId, pathName: `court-${index + 1}` })),
      videoInputs: [{ deviceId: VIDEO_DEVICE_ID, kind: 'v4l2', devicePath: '/dev/video0', inputPixelFormat: 'yuyv422' }],
      audioInputs: [{ deviceId: AUDIO_DEVICE_ID, kind: 'alsa', deviceName: 'hw:1,0' }],
    },
  } as const;
}

describe('local media schemas', () => {
  it('parses the pinned four-court loopback configuration', () => {
    const config = LocalMediaRuntimeConfigSchema.parse(mediaConfig());

    expect(config.bindings.courts).toHaveLength(4);
    expect(config.mediaMtxVersion).toBe('1.21.0');
  });

  it.each([
    ['wrong version', { mediaMtxVersion: '1.20.0' }],
    ['relative executable', { ffmpegExecutablePath: 'ffmpeg' }],
    ['wrong runtime mode', { runtimeDirectoryMode: 0o755 }],
    ['unknown command field', { argv: ['--unsafe'] }],
  ])('rejects %s', (_label, override) => {
    expect(() => LocalMediaRuntimeConfigSchema.parse({ ...mediaConfig(), ...override })).toThrow();
  });

  it('rejects duplicate and unsafe court bindings', () => {
    const base = mediaConfig();
    const unsafe = {
      ...base,
      bindings: {
        ...base.bindings,
        courts: base.bindings.courts.map((binding, index) => index === 3
          ? { courtId: courtIds[0], pathName: '../secret' }
          : binding),
      },
    };

    expect(() => LocalMediaRuntimeConfigSchema.parse(unsafe)).toThrow();
  });

  it('rejects non-loopback hosts and privileged ports', () => {
    const base = mediaConfig();
    const bindings = { ...base.bindings, apiHost: '0.0.0.0', srtPort: 443 };

    expect(() => LocalMediaRuntimeConfigSchema.parse({ ...base, bindings })).toThrow();
  });

  it('rejects a non-loopback SRT host independently of the API binding', () => {
    const base = mediaConfig();
    const bindings = { ...base.bindings, srtHost: '192.0.2.10' };

    expect(() => LocalMediaRuntimeConfigSchema.parse({ ...base, bindings })).toThrow();
  });
});

describe('MediaMTX v1.21.0 plan', () => {
  it('builds a least-privilege loopback API and four loopback SRT publisher paths', () => {
    // Given
    const config = LocalMediaRuntimeConfigSchema.parse(mediaConfig());

    // When
    const plan = buildMediaMtxPlan(config, '/run/user/1000/kpl-agent/run/config.yml', apiUser);
    const document = parse(plan.configYaml);

    // Then
    expect(plan.command).toEqual({
      executable: '/opt/kpl/bin/mediamtx',
      argv: ['/run/user/1000/kpl-agent/run/config.yml'],
      cwd: '/run/user/1000/kpl-agent',
      env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    expect(document).toMatchObject({
      api: true,
      apiAddress: '127.0.0.1:9997',
      apiEncryption: false,
      srt: true,
      srtAddress: '127.0.0.1:8890',
      authMethod: 'internal',
      rtsp: false,
      rtmp: false,
      hls: false,
      webrtc: false,
      moq: false,
      logDestinations: ['stdout'],
      logStructured: true,
      paths: {
        'court-1': { source: 'publisher', overridePublisher: false },
        'court-4': { source: 'publisher', overridePublisher: false },
      },
    });
    expect(document.authInternalUsers).toEqual([{
      user: apiUser.username,
      pass: apiUser.passwordHash,
      ips: ['127.0.0.1', '::1'],
      permissions: [{ action: 'api' }],
    }, {
      user: 'any',
      ips: ['127.0.0.1', '::1'],
      permissions: courtIds.map((_courtId, index) => ({ action: 'publish', path: `court-${index + 1}` })),
    }]);
    expect(buildMediaMtxPlan(config, '/run/user/1000/kpl-agent/run/config.yml', apiUser).configYaml)
      .toBe(plan.configYaml);
    expect(JSON.stringify(plan.command)).not.toContain(apiUser.passwordHash);
    expect(plan.command.argv.join(' ')).not.toContain(apiUser.passwordHash);
    expect(JSON.stringify(plan.command.env)).not.toContain(apiUser.passwordHash);
    expect(JSON.stringify(plan.command)).not.toContain(clearPasswordSentinel);
    expect(plan.command.argv.join(' ')).not.toContain(clearPasswordSentinel);
    expect(JSON.stringify(plan.command.env)).not.toContain(clearPasswordSentinel);
  });

  it('rejects non-derived API passwords without leaking them in errors', () => {
    // Given
    const config = LocalMediaRuntimeConfigSchema.parse(mediaConfig());
    let errorMessage = '';

    // When
    try {
      buildMediaMtxPlan(config, '/run/user/1000/kpl-agent/run/config.yml', {
        username: apiUser.username,
        passwordHash: clearPasswordSentinel,
      });
    } catch (error) {
      if (error instanceof Error) errorMessage = error.message;
      else throw error;
    }

    // Then
    expect(errorMessage).not.toBe('');
    expect(errorMessage).not.toContain(clearPasswordSentinel);
  });

  it('rejects the unauthenticated wildcard as an API username', () => {
    // Given
    const config = LocalMediaRuntimeConfigSchema.parse(mediaConfig());

    // When
    const build = () => buildMediaMtxPlan(config, '/run/user/1000/kpl-agent/run/config.yml', {
      ...apiUser,
      username: 'any',
    });

    // Then
    expect(build).toThrow();
  });
});

describe('FFmpeg plan', () => {
  it.each([false, true])('orders capture, optional overlay, codecs, progress, and SRT output (overlay=%s)', (overlayEnabled) => {
    const currentProfile = { ...profile(), overlayEnabled };
    const input = {
      executablePath: '/opt/kpl/bin/ffmpeg',
      cwd: '/run/user/1000/kpl-agent',
      profile: currentProfile,
      video: { deviceId: VIDEO_DEVICE_ID, kind: 'v4l2', devicePath: '/dev/video0', inputPixelFormat: 'yuyv422' },
      audio: { deviceId: AUDIO_DEVICE_ID, kind: 'alsa', deviceName: 'hw:1,0' },
      overlay: overlayEnabled
        ? { fd: 4 as const, pixelFormat: 'rgba' as const, width: 1920, height: 1080, framesPerSecond: 60 }
        : null,
      sink: { host: '127.0.0.1', port: 8890, pathName: 'court-1' },
    } as const;

    const plan = buildFfmpegCommandPlan(input);
    const joined = plan.argv.join(' ');

    expect(plan.shell).toBe(false);
    expect(plan.env).toEqual({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
    expect(joined.startsWith('-nostdin -nostats -loglevel warning -progress pipe:3 -stats_period 1')).toBe(true);
    expect(joined).toContain('-f v4l2 -input_format yuyv422 -framerate 60 -video_size 1920x1080 -i /dev/video0');
    expect(joined).toContain('-f alsa -i hw:1,0');
    expect(joined).toContain('-c:v libx264 -b:v 8000k');
    expect(joined).toContain('-c:a aac -b:a 192k -f mpegts srt://127.0.0.1:8890?streamid=publish:court-1');
    expect(joined.includes('-i pipe:4')).toBe(overlayEnabled);
    expect(JSON.stringify(plan)).not.toMatch(/SECRET_SENTINEL|local:\/\/|password|token/i);
  });

  it('rejects enabled overlay without fd4 descriptor', () => {
    const build = () => buildFfmpegCommandPlan({
      executablePath: '/opt/kpl/bin/ffmpeg',
      cwd: '/run/kpl',
      profile: profile(),
      video: { deviceId: VIDEO_DEVICE_ID, kind: 'v4l2', devicePath: '/dev/video0', inputPixelFormat: 'yuyv422' },
      audio: null,
      overlay: null,
      sink: { host: '127.0.0.1', port: 8890, pathName: 'court-1' },
    });

    expect(build).toThrow();
  });

  it('emits a video-only plan when the profile has no audio device', () => {
    const plan = buildFfmpegCommandPlan({
      executablePath: '/opt/kpl/bin/ffmpeg',
      cwd: '/run/kpl',
      profile: { ...profile(), audioSourceDeviceId: null, overlayEnabled: false },
      video: { deviceId: VIDEO_DEVICE_ID, kind: 'v4l2', devicePath: '/dev/video0', inputPixelFormat: 'mjpeg' },
      audio: null,
      overlay: null,
      sink: { host: '127.0.0.1', port: 8890, pathName: 'court-1' },
    });

    expect(plan.argv).toContain('-an');
    expect(plan.argv).not.toContain('alsa');
    expect(plan.stdio[4]).toBe('ignore');
  });
});
