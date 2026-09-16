import { describe, expect, it, vi } from 'vitest';
import {
  CPU_ENCODER, detectVideoEncoders, encoderFilter, encoderInputArguments, encoderKey,
  encoderOutputArguments, isHardwareEncoderFailure, selectVideoEncoder,
} from '../src/pilot-video-encoder.js';

describe('automatic video encoding', () => {
  it('rejects compiled-in encoders whose hardware cannot actually encode', async () => {
    const probe = vi.fn(async (_path: string, args: readonly string[]) => ({
      ok: args.includes('-encoders'), stdout: ' V..... h264_nvenc\n V..... h264_vaapi\n',
    }));
    const encoders = await detectVideoEncoders('ffmpeg', { probe, platform: 'linux', renderDevices: ['/dev/dri/renderD128'] });
    expect(encoders).toEqual([CPU_ENCODER]);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('only selects a GPU for frame rates verified at the production resolution and bitrate', async () => {
    const probe = vi.fn(async (_path: string, args: readonly string[]) => ({
      ok: args.includes('-encoders') || args.includes('testsrc2=size=1920x1080:rate=30'),
      stdout: ' V..... h264_nvenc',
    }));
    const encoders = await detectVideoEncoders('ffmpeg', { probe, platform: 'win32' });
    expect(encoders[0]).toMatchObject({ name: 'h264_nvenc', frameRates: [30] });
    expect(selectVideoEncoder(encoders, 30, new Set()).hardware).toBe(true);
    expect(selectVideoEncoder(encoders, 60, new Set())).toEqual(CPU_ENCODER);
    const args = probe.mock.calls[1]![1];
    expect(args).toEqual(expect.arrayContaining(['-frames:v', '3', '-b:v', '6000k', '-g', '60', '-rc', 'cbr']));
    expect(args).not.toContain('-x264-params');
  });

  it('finds a working render node after an inaccessible one and uploads software frames to VAAPI', async () => {
    const probe = vi.fn(async (_path: string, args: readonly string[]) => ({
      ok: args.includes('-encoders') || args.includes('/dev/dri/renderD129'), stdout: ' V..... h264_vaapi',
    }));
    const encoders = await detectVideoEncoders('ffmpeg', { probe, platform: 'linux',
      renderDevices: ['/dev/dri/renderD128', '/dev/dri/renderD129'] });
    const selected = selectVideoEncoder(encoders, 60, new Set());
    expect(selected).toMatchObject({ name: 'h264_vaapi', device: '/dev/dri/renderD129', frameRates: [30, 60] });
    expect(encoderInputArguments(selected)).toEqual(['-vaapi_device', '/dev/dri/renderD129']);
    expect(encoderFilter(selected)).toBe('format=nv12,hwupload');
    expect(encoderOutputArguments(selected, 60)).toEqual(expect.arrayContaining(['-rc_mode', 'CBR', '-b:v', '9000k']));
  });

  it('supports AMD and Intel on native Windows and skips a rejected encoder on recovery', async () => {
    const encoders = await detectVideoEncoders('ffmpeg', { platform: 'win32',
      probe: async () => ({ ok: true, stdout: 'h264_amf h264_qsv' }) });
    const amd = selectVideoEncoder(encoders, 30, new Set());
    expect(amd.name).toBe('h264_amf');
    const rejected = new Set([encoderKey(amd)]);
    const intel = selectVideoEncoder(encoders, 30, rejected);
    expect(intel.name).toBe('h264_qsv');
    rejected.add(encoderKey(intel));
    expect(selectVideoEncoder(encoders, 30, rejected)).toEqual(CPU_ENCODER);
    expect(encoderOutputArguments(amd, 30)).not.toContain('-preset');
  });

  it('keeps CPU available when FFmpeg detection fails or no GPU exists', async () => {
    expect(await detectVideoEncoders('missing', { probe: async () => ({ ok: false, stdout: '' }) })).toEqual([CPU_ENCODER]);
    expect(await detectVideoEncoders('ffmpeg', { platform: 'linux', renderDevices: [],
      probe: async () => ({ ok: true, stdout: 'libx264' }) })).toEqual([CPU_ENCODER]);
  });

  it('distinguishes GPU failures from a network or source failure', () => {
    expect(isHardwareEncoderFailure('[h264_nvenc] OpenEncodeSessionEx failed: out of memory')).toBe(true);
    expect(isHardwareEncoderFailure('Error while opening encoder for output stream')).toBe(true);
    expect(isHardwareEncoderFailure('[rtsp] Connection timed out')).toBe(false);
    expect(isHardwareEncoderFailure('Broken pipe')).toBe(false);
  });
});
