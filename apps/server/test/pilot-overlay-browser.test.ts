import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { chromium, type Browser } from 'playwright';
import { expect, it } from 'vitest';
import type { PilotOverlayHealth } from '@kpl/production-contracts';
import { BrowserPilotOverlayRenderer } from '../src/pilot-overlay.js';
import { ffmpegEnvironment } from '../src/pilot-video-encoder.js';

it('keeps FFmpeg progressing through page, data and browser faults while preserving the last valid overlay', async () => {
  const navigations = new Map<string, number>();
  let initiallyReady = false;
  const server = createServer((request, response) => {
    const court = request.url!.includes('pista-1') ? 'pista-1' : 'pista-2';
    const count = (navigations.get(court) ?? 0) + 1; navigations.set(court, count);
    response.setHeader('content-type', 'text/html');
    response.end(`<html><body style="margin:0;background:transparent"><div data-pilot-match-ready="${initiallyReady}"
      data-pilot-confirmed-at="${Date.now()}" style="font:80px sans-serif;color:white">${court}: ${count}</div>
      <script>window.confirmationTimer = setInterval(() => document.querySelector('[data-pilot-match-ready]').setAttribute('data-pilot-confirmed-at', Date.now()), 100);</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server');
  const browsers: Browser[] = [];
  const renderer = new BrowserPilotOverlayRenderer({ baseUrl: `http://127.0.0.1:${address.port}` }, async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    browsers.push(browser); return browser;
  });
  const states: PilotOverlayHealth[][] = [[], []];
  const frames: string[][] = [[], []];
  const encoder = spawn('/usr/bin/ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.5',
    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-thread_queue_size', '8', '-probesize', '32', '-fpsprobesize', '0',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', '30', '-i', 'pipe:3',
    '-filter_complex', '[1:v]scale=160:90[score];[0:v][score]overlay=0:0:format=auto', '-an', '-f', 'null', '-'],
  { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: ffmpegEnvironment() });
  const encoderInput = encoder.stdio[3] as Writable;
  encoderInput.on('error', () => undefined);
  let encoded = 0;
  encoder.stdout!.on('data', (chunk: Buffer) => {
    const values = [...chunk.toString().matchAll(/frame=(\d+)/g)];
    if (values.length) encoded = Number(values.at(-1)![1]);
  });
  encoder.stderr!.resume();
  const encoderClosed = new Promise<void>((resolve) => encoder.once('close', () => resolve()));
  const controllers = [new AbortController(), new AbortController()];
  const outputs = frames.map((history, index) => new Writable({ write(chunk: Buffer, _encoding, done) {
    expect(chunk.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    history.push(createHash('sha256').update(chunk).digest('hex'));
    if (index === 0) encoderInput.write(chunk, done); else done();
  }, final(done) { if (index === 0) encoderInput.end(done); else done(); } }));
  const running = outputs.map((output, index) => renderer.start(output,
    { courtSlug: `pista-${index + 1}`, framesPerSecond: 30, homeTeamId: 'kings', awayTeamId: 'lions',
      onState: (state) => states[index]!.push(state) }, controllers[index]!.signal));
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(condition(), JSON.stringify(states)).toBe(true);
  };
  try {
    await until(() => browsers[0]?.contexts().flatMap((context) => context.pages()).filter((page) => page.url().includes('/overlay/')).length === 2);
    const pendingPages = browsers[0]!.contexts().flatMap((context) => context.pages());
    await Promise.all(pendingPages.map((page) => page.waitForSelector('[data-pilot-match-ready="false"]')));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(frames.every((history) => history.length === 0)).toBe(true);
    initiallyReady = true;
    await Promise.all(pendingPages.map((page) => page.evaluate(`document.querySelector('[data-pilot-match-ready]').setAttribute('data-pilot-match-ready', 'true')`)));
    await until(() => states.every((history) => history.at(-1)?.status === 'ready') && frames.every((history) => history.length > 8));
    await until(() => encoded > 5);
    const initialEncoded = encoded;
    const browser = browsers[0]!;
    const pages = browser.contexts().flatMap((context) => context.pages());
    const first = pages.find((page) => page.url().includes('pista-1'))!;
    const second = pages.find((page) => page.url().includes('pista-2'))!;
    expect(first.url()).toContain('homeTeamId=kings&awayTeamId=lions');
    const hash = frames[0]!.at(-1);
    const count = frames[0]!.length;
    await first.close();
    await until(() => states[0]!.at(-1)?.holdingLastFrame === true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(frames[0]!.length).toBeGreaterThan(count + 12);
    expect(frames[0]!.at(-1)).toBe(hash);
    await until(() => states[0]!.at(-1)?.status === 'ready' && frames[0]!.at(-1) !== hash);
    expect(second.isClosed()).toBe(false);
    expect(states[1]!.filter(({ status }) => status === 'recovering')).toHaveLength(0);
    const current = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('pista-1'))!;
    const latest = frames[0]!.at(-1);
    await current.evaluate(`clearInterval(window.confirmationTimer); document.querySelector('[data-pilot-match-ready]').setAttribute('data-pilot-confirmed-at', Date.now() - 20000)`);
    await until(() => states[0]!.at(-1)?.holdingLastFrame === true);
    expect(frames[0]!.at(-1)).toBe(latest);
    await until(() => states[0]!.at(-1)?.status === 'ready' && frames[0]!.at(-1) !== latest);
    expect(second.isClosed()).toBe(false);
    const blocked = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('pista-1'))!;
    const blockedHash = frames[0]!.at(-1);
    const beforeBlock = encoded;
    void blocked.evaluate('while (true) {}').catch(() => undefined);
    await until(() => states[0]!.at(-1)?.holdingLastFrame === true);
    expect(frames[0]!.at(-1)).toBe(blockedHash);
    expect(encoded).toBeGreaterThan(beforeBlock + 20);
    await until(() => states[0]!.at(-1)?.status === 'ready' && frames[0]!.at(-1) !== blockedHash);
    const before = frames.map((history) => history.length);
    await browser.close();
    await until(() => browsers.length === 2 && states.every((history) => history.at(-1)?.status === 'ready')
      && frames.every((history, index) => history.length > before[index]! + 20));
    expect(states.every((history) => history.some(({ holdingLastFrame }) => holdingLastFrame))).toBe(true);
    expect(encoded).toBeGreaterThan(initialEncoded + 100);
    expect(encoder.exitCode).toBeNull();
    expect(encoder.signalCode).toBeNull();
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.allSettled(running); await renderer.close();
    outputs.forEach((output) => output.destroy());
    encoder.kill('SIGTERM');
    const force = setTimeout(() => encoder.kill('SIGKILL'), 2_000);
    await encoderClosed; clearTimeout(force);
    await Promise.all(browsers.map((browser) => browser.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 40_000);
