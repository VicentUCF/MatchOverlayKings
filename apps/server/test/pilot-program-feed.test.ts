import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { renderContinuityFrame } from '@kpl/production-assets';
import { expect, it, vi } from 'vitest';
import { PilotProgramFeed, type ProgramSourceState } from '../src/pilot-program-feed.js';

it('renders escaped titles and a BT.709 continuity frame that FFmpeg decodes with the intended colors', () => {
  const frame = renderContinuityFrame('Pista 1', 'Kings & Lions <Final>');
  expect(frame.yuv.byteLength).toBe(1920 * 1080 * 3 / 2);
  expect(Buffer.from(frame.png).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const decoded = spawnSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo',
    '-pixel_format', 'yuv420p', '-video_size', '1920x1080', '-colorspace', 'bt709', '-color_range', 'tv', '-i', 'pipe:0',
    '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
  { input: frame.yuv, maxBuffer: 8 * 1024 * 1024, timeout: 5_000 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  expect(decoded.stdout.length).toBe(1920 * 1080 * 3);
  for (const [index, expected] of [21, 24, 32].entries()) expect(Math.abs(decoded.stdout[index]! - expected)).toBeLessThanOrEqual(2);
});

it('keeps paired video and audio flowing through a real capture failure and recovery', async () => {
  const states: ProgramSourceState[] = [];
  const fallback = new Uint8Array(160 * 90 * 3 / 2).fill(90);
  let frames = 0; let audioBytes = 0; let fallbackFrames = 0;
  const video = new Writable({ write(chunk: Buffer, _encoding, done) {
    expect(chunk.length).toBe(fallback.length); frames++;
    if (chunk.equals(Buffer.from(fallback))) fallbackFrames++;
    done();
  } });
  const audio = new Writable({ write(chunk: Buffer, _encoding, done) { audioBytes += chunk.length; done(); } });
  const feed = new PilotProgramFeed({ executable: '/usr/bin/ffmpeg', source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' },
    sourceReady: () => true, mobileRtspUrl: null, mobileAudioAvailable: false, fps: 30,
    width: 160, height: 90, fallback, onState: (state) => states.push(state), onProcess: () => undefined });
  const running = feed.start(video, audio);
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(condition(), JSON.stringify(states)).toBe(true);
  };
  try {
    await until(() => states.some(({ active }) => !active));
    const previous = feed.captureProcess;
    expect(previous).not.toBeNull();
    const before = frames; const fallbackBefore = fallbackFrames;
    previous!.kill('SIGKILL');
    await until(() => states.at(-1)?.active === true);
    await until(() => feed.captureProcess !== previous && states.at(-1)?.active === false);
    expect(frames).toBeGreaterThan(before + 20);
    expect(fallbackFrames).toBeGreaterThan(fallbackBefore + 20);
  } finally { await feed.close(); await running; video.end(); audio.end(); }
  expect(audioBytes).toBe(frames * 6_400);
  expect(feed.captureProcess).toBeNull();
}, 15_000);

it('bounds automatic attempts while continuing the program and permits a fresh manual retry', async () => {
  vi.useFakeTimers();
  const states: ProgramSourceState[] = [];
  const sourceReady = vi.fn(() => false);
  let frames = 0;
  const video = new Writable({ write(_chunk, _encoding, done) { frames++; done(); } });
  const audio = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const feed = new PilotProgramFeed({ executable: '/usr/bin/ffmpeg', source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' },
    sourceReady, mobileRtspUrl: null, mobileAudioAvailable: false, fps: 30,
    width: 160, height: 90, fallback: new Uint8Array(160 * 90 * 3 / 2),
    onState: (state) => states.push(state), onProcess: () => undefined });
  const running = feed.start(video, audio);
  try {
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sourceReady).toHaveBeenCalledTimes(6);
    expect(states.at(-1)).toMatchObject({ active: true, attempt: 5, exhausted: true });
    const before = frames;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames).toBeGreaterThan(before + 140);
    expect(sourceReady).toHaveBeenCalledTimes(6);
    await feed.recover();
    expect(states.at(-1)).toMatchObject({ active: true, attempt: 0, exhausted: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sourceReady).toHaveBeenCalledTimes(8);
  } finally { await feed.close(); await running; video.end(); audio.end(); vi.useRealTimers(); }
  expect(feed.captureProcess).toBeNull();
});
