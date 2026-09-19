import { Writable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { PilotOverlayHealth } from '@kpl/production-contracts';
import { PilotOverlayFeed } from '../src/pilot-overlay-feed.js';

afterEach(() => vi.useRealTimers());

it('keeps the last frame flowing during capture recovery and resets attempts only after stable output', async () => {
  vi.useFakeTimers();
  const frames: string[] = [];
  const states: PilotOverlayHealth[] = [];
  let fail: () => void = () => undefined;
  let captures = 0;
  const publishers: Array<(png: Uint8Array) => void> = [];
  const feed = new PilotOverlayFeed(async (frame, signal) => {
    publishers.push(frame);
    frame(Buffer.from(`score-${++captures}`));
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      fail = () => reject(new Error('private URL must never be exposed'));
    });
  }, 30, (state) => states.push(state));
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { frames.push(chunk.toString()); done(); } });
  const lifetime = new AbortController();
  const running = feed.start(output, lifetime.signal);
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(states.at(-1)?.status).toBe('ready');
    const before = frames.length;
    fail();
    await vi.advanceTimersByTimeAsync(900);
    expect(frames.length).toBeGreaterThan(before + 20);
    expect(new Set(frames)).toEqual(new Set(['score-1']));
    expect(states.at(-1)).toMatchObject({ status: 'recovering', holdingLastFrame: true, attempt: 0 });
    await vi.advanceTimersByTimeAsync(200);
    expect(frames.at(-1)).toBe('score-2');
    expect(states.at(-1)).toMatchObject({ status: 'ready', attempt: 1 });
    publishers[0]!(Buffer.from('stale callback'));
    await vi.advanceTimersByTimeAsync(100);
    expect(frames.at(-1)).toBe('score-2');
    await vi.advanceTimersByTimeAsync(30_100);
    expect(states.at(-1)).toMatchObject({ status: 'ready', attempt: 0 });
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(1);
    expect(JSON.stringify(states)).not.toContain('private URL');
  } finally { await feed.close(); await running; output.destroy(); }
  expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
});

it('exhausts five retries without sending an invalid initial frame, then resumes on manual recovery', async () => {
  vi.useFakeTimers();
  let allowed = false;
  const states: PilotOverlayHealth[] = [];
  const frames: string[] = [];
  const capture = vi.fn(async (frame: (png: Uint8Array) => void, signal: AbortSignal) => {
    if (!allowed) throw new Error('offline');
    frame(Buffer.from('validated match'));
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const feed = new PilotOverlayFeed(capture, 30, (state) => states.push(state));
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { frames.push(chunk.toString()); done(); } });
  const running = feed.start(output, new AbortController().signal);
  try {
    await vi.advanceTimersByTimeAsync(31_100);
    expect(capture).toHaveBeenCalledTimes(6);
    expect(states.at(-1)).toMatchObject({ status: 'failed', attempt: 5, lastFrameAt: null, holdingLastFrame: false });
    expect(frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(capture).toHaveBeenCalledTimes(6);
    allowed = true; feed.recover();
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)).toMatchObject({ status: 'ready', attempt: 0 });
    expect(frames.at(-1)).toBe('validated match');
  } finally { await feed.close(); await running; output.destroy(); }
});

it('can close while the output pipe applies backpressure', async () => {
  const output = new Writable({ write() { /* Encoder is not reading. */ } });
  const feed = new PilotOverlayFeed(async (frame, signal) => {
    frame(Buffer.from('valid frame'));
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, 30, () => undefined);
  const running = feed.start(output, new AbortController().signal);
  await feed.close(); await running;
  output.destroy();
});
