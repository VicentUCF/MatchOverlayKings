import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { PilotProgramFeed } from '../src/pilot-program-feed.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

it('keeps continuity and captures a replacement phone after exhausting retries, using its audio capabilities', async () => {
  vi.useFakeTimers();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()],
      exitCode: null, signalCode: null,
      kill: () => { child.emit('close'); return true; },
    });
    return child;
  });
  let mobile: { url: string; audioAvailable: boolean } | null = { url: 'rtsp://localhost/old', audioAvailable: true };
  let frames = 0;
  const video = new Writable({ write(_chunk, _encoding, done) { frames++; done(); } });
  const audio = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const onState = vi.fn();
  const feed = new PilotProgramFeed({ executable: '/fake/ffmpeg', source: { id: 'mobile:pilot', kind: 'mobile', label: 'Móvil' },
    sourceReady: () => mobile !== null, resolveMobileSource: () => mobile,
    mobileRtspUrl: 'rtsp://localhost/old', mobileAudioAvailable: true, fps: 30,
    width: 160, height: 90, fallback: new Uint8Array(160 * 90 * 3 / 2), onState, onProcess: () => undefined });
  const running = feed.start(video, audio);
  try {
    expect(mocks.spawn.mock.calls[0]![1]).toContain('rtsp://localhost/old');
    mobile = null;
    feed.captureProcess!.emit('close');
    await vi.advanceTimersByTimeAsync(32_000);
    expect(onState.mock.lastCall![0]).toMatchObject({ exhausted: true });
    const before = frames;
    mobile = { url: 'rtsp://localhost/replacement', audioAvailable: false };
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toBeGreaterThan(before);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const args = mocks.spawn.mock.lastCall![1] as string[];
    expect(args).toContain(mobile.url);
    expect(args).not.toContain('rtsp://localhost/old');
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
    expect(args.some((arg) => arg.includes('fps=30,format=yuv420p'))).toBe(true);
  } finally { await feed.close(); await running; vi.useRealTimers(); }
});
