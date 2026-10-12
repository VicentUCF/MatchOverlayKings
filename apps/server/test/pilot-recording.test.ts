import { expect, it, vi } from 'vitest';
import { pilotProgramCommand } from '../src/features/pilot/pilot-program-command.js';
import { CPU_ENCODER } from '../src/features/pilot/pilot-video-encoder.js';
import { checkPilotMetadata } from '../src/features/pilot/pilot-preflight-checks.js';
import { captureArguments } from '../src/features/pilot/pilot-program-feed.js';
import { parseDirectShowDevices } from '../src/features/pilot/pilot-windows-devices.js';
import { PilotConfigurationSchema, RecordingPlanSchema } from '@kpl/production-contracts';

it('writes the full composed program to a non-overwriting fragmented MP4 instead of the network', () => {
  const { argv } = pilotProgramCommand('ffmpeg', 'rtmp://unused/live', 30, CPU_ENCODER, undefined, '/data/part 1.mp4');
  expect(argv).toEqual(expect.arrayContaining(['[vout]', '[aout]', 'aac', 'libx264']));
  expect(argv.slice(-6)).toEqual(['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-n', '/data/part 1.mp4']);
  expect(argv).not.toContain('rtmp://unused/live');
  expect(argv).not.toContain('-t');
});

it('keeps simulation, YouTube and the bounded preflight preview outputs unchanged', () => {
  expect(pilotProgramCommand('ffmpeg', null, 30, CPU_ENCODER).argv.slice(-3)).toEqual(['-f', 'null', '-']);
  expect(pilotProgramCommand('ffmpeg', 'rtmp://host/live', 30, CPU_ENCODER).argv.slice(-3)).toEqual(['-f', 'flv', 'rtmp://host/live']);
  expect(pilotProgramCommand('ffmpeg', null, 30, CPU_ENCODER, { path: '/preview.mp4', seconds: 10 }).argv.slice(-8))
    .toEqual(['-t', '10', '-movflags', '+faststart', '-f', 'mp4', '-n', '/preview.mp4']);
});

it('lets FFmpeg finalize a Windows recording through stdin', () => {
  const command = pilotProgramCommand('ffmpeg.exe', null, 30, CPU_ENCODER, undefined, 'match.mp4', 'win32');
  expect(command.argv).not.toContain('-nostdin');
  expect(command.argv).toContain('match.mp4');
  expect(command.argv).not.toContain('flv');
});

it('discovers DirectShow cameras and microphones by their stable alternative names', () => {
  const devices = parseDirectShowDevices(`
[dshow @ 0001] "GoPro Webcam" (video)
[dshow @ 0001]   Alternative name "@device_pnp_\\\\?\\usb#camera"
[dshow @ 0001] "USB Microphone" (audio)
[dshow @ 0001]   Alternative name "@device_cm_{mic}\\wave"
`);
  expect(devices.cameras[0]).toMatchObject({ kind: 'dshow', label: 'GoPro Webcam' });
  expect(devices.audioInputs[0]).toMatchObject({ label: 'USB Microphone' });
  expect(devices.cameras[0]?.deviceName).toContain('@device_pnp_');
  expect(devices.audioInputs[0]?.id).toMatch(/^dshow-audio:[a-f0-9]{64}$/);
});

it('reads earlier recording configurations and preserves per-input gain in new plans', () => {
  const common = { courtSlug: 'pista-1', sourceId: 'mobile:pilot', homeTeam: 'Kings', awayTeam: 'Lions',
    matchdayNumber: 1, seasonLabel: 'T2' };
  expect(PilotConfigurationSchema.safeParse({ ...common, mode: 'recording', scheduledAt: new Date().toISOString(),
    privacyStatus: 'private', updatedAt: new Date().toISOString() }).success).toBe(true);
  const plan = RecordingPlanSchema.parse({ ...common, kind: 'recording', recordingDirectory: '/tmp/recordings',
    audioInputs: [{ id: `dshow-audio:${'a'.repeat(64)}`, gain: 1.4 }], includeSourceAudio: false });
  expect(plan.audioInputs?.[0]?.gain).toBe(1.4);
  expect(plan.includeSourceAudio).toBe(false);
});

it('mixes selected microphones and mobile sound into one PCM feed for the final AAC track', () => {
  const options = {
    executable: 'ffmpeg.exe', source: { id: 'mobile', kind: 'mobile', label: 'Móvil' } as const,
    mobileRtspUrl: 'rtsp://127.0.0.1/mobile', mobileAudioAvailable: true, includeSourceAudio: true,
    audioInputs: [{ deviceName: '@mic-one', gain: 1 }, { deviceName: '@mic-two', gain: 0.5 }],
    sourceReady: () => true, fps: 30 as const, fallback: new Uint8Array(),
    onState: () => undefined, onProcess: () => undefined,
  };
  const argv = captureArguments(options);
  const filter = argv[argv.indexOf('-filter_complex') + 1];
  expect(argv).toContain('audio=@mic-one');
  expect(argv).toContain('audio=@mic-two');
  expect(argv).not.toContain('anullsrc=r=48000:cl=stereo');
  expect(filter).toContain('[0:a:0]aresample=async=1000:first_pts=0,volume=1[a0]');
  expect(filter).toContain('[2:a:0]aresample=async=1000:first_pts=0,volume=0.5[a2]');
  expect(filter).toContain('amix=inputs=3:duration=longest:normalize=0');
  expect(argv.filter((value) => value === '[mix]')).toHaveLength(1);
  const withoutMobile = captureArguments({ ...options, source: { id: 'gopro', kind: 'dshow', label: 'GoPro', deviceName: '@camera' },
    mobileAudioAvailable: false });
  expect(withoutMobile).toContain('video=@camera');
  expect(withoutMobile[withoutMobile.indexOf('-filter_complex') + 1]).toContain('[1:a:0]');
});

it('does not contact YouTube or measure internet upload for local recordings', async () => {
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Unexpected network request'); });
  const context = {
    source: { id: 'synthetic', kind: 'synthetic', label: 'Test' } as const,
    mode: 'recording' as const, mobile: null, assertMatch: forbidden, host: forbidden,
    destination: forbidden, transport: forbidden, upload: forbidden, mediaMtx: forbidden,
  };
  expect((await checkPilotMetadata('destination', context)).status).toBe('not_applicable');
  expect((await checkPilotMetadata('network', context)).status).toBe('not_applicable');
  expect(forbidden).not.toHaveBeenCalled();
});
