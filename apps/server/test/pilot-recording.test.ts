import { expect, it, vi } from 'vitest';
import { pilotProgramCommand } from '../src/pilot-program-command.js';
import { CPU_ENCODER } from '../src/pilot-video-encoder.js';
import { checkPilotMetadata } from '../src/pilot-preflight-checks.js';

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
