import { createServer } from 'node:http';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserPilotOverlayRenderer } from '../src/pilot-overlay.js';
import { probePilotMedia, type PilotMediaProbeOptions } from '../src/pilot-preflight-media.js';
import { detectVideoEncoders } from '../src/pilot-video-encoder.js';
import { checkPilotMedia } from '../src/pilot-preflight-checks.js';

let directory: string;
let renderer: BrowserPilotOverlayRenderer;
let encoder: PilotMediaProbeOptions['encoder'];
let ready = true;
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(`<html><body style="margin:0;background:transparent"><div data-pilot-match-ready="${ready}"
    data-pilot-confirmed-at="${Date.now()}" style="width:160px;height:160px;background:#2040ff">MARCADOR</div>
    <script>setInterval(() => document.querySelector('div').setAttribute('data-pilot-confirmed-at', Date.now()), 100);</script></body></html>`);
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kpl-preflight-media-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  renderer = new BrowserPilotOverlayRenderer({ baseUrl: `http://127.0.0.1:${address.port}` });
  encoder = (await detectVideoEncoders('/usr/bin/ffmpeg'))[0]!;
}, 30_000);
afterAll(async () => {
  await renderer?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
function options(name: string, signal: AbortSignal): PilotMediaProbeOptions {
  return { path: join(directory, name, 'preview.mp4'), renderer, encoder, signal, audioExpected: false,
    overlay: { courtSlug: 'pista-1', framesPerSecond: 30 },
    source: { executable: '/usr/bin/ffmpeg', source: { id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba' },
      mobileRtspUrl: null, mobileAudioAvailable: false, sourceReady: () => true,
      fps: 30, fallback: new Uint8Array(1920 * 1080 * 3 / 2) } };
}

it('records and decodes ten seconds of the real composed program with H264, audio and a browser overlay', async () => {
  const input = options('complete', new AbortController().signal);
  const result = await probePilotMedia(input);
  expect(result, JSON.stringify(result)).toMatchObject({ completed: true, cameraReceived: true, cameraInterrupted: false,
    overlayReceived: true, overlayInterrupted: false, hardwareFailure: false });
  expect(result.frames).toBeGreaterThanOrEqual(300);
  expect(result.durationSeconds).toBeGreaterThanOrEqual(10);
  expect(result.sizeBytes).toBeGreaterThan(100_000);
  expect(result.elapsedSeconds).toBeLessThan(35);
  expect(checkPilotMedia(result, false).encoder, JSON.stringify(result)).toMatchObject({ status: 'pass' });
  expect((await stat(input.path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(directory, 'complete'))).mode & 0o777).toBe(0o700);
  const decoded = execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-ss', '2', '-i', input.path,
    '-vf', 'crop=16:16:80:80', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { timeout: 5_000 });
  expect(decoded.length).toBe(16 * 16 * 3);
  // The camera test pattern has a red block here; the decoded blue proves composition happened.
  expect(decoded[2]).toBeGreaterThan(220);
  expect(decoded[0]).toBeLessThan(60);
}, 50_000);

it('never accepts generated continuity as a camera sample and cleans cancelled capture and encoder processes', async () => {
  const abort = new AbortController();
  const input = options('missing', abort.signal);
  const processes = new Set<ChildProcess>();
  const timer = setTimeout(() => abort.abort(), 2_500);
  let result;
  try { result = await probePilotMedia({ ...input, source: { ...input.source, sourceReady: () => false },
    onProcess: (output, capture) => { if (output) processes.add(output); if (capture) processes.add(capture); } }); }
  finally { clearTimeout(timer); }
  expect(result).toMatchObject({ completed: false, cameraReceived: false, frames: 0, sizeBytes: 0 });
  await expect(readFile(input.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect([...processes].every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}, 15_000);

it('rejects a preview when the camera drops, even if capture automatically recovers before the clip ends', async () => {
  const input = options('interrupted', new AbortController().signal);
  let killed = false; let timer: NodeJS.Timeout | undefined;
  let result;
  try { result = await probePilotMedia({ ...input, onProcess: (_output, capture) => {
    if (capture && !killed) { killed = true; timer = setTimeout(() => capture.kill('SIGKILL'), 3_000); }
  } }); } finally { clearTimeout(timer); }
  expect(result).toMatchObject({ completed: false, cameraReceived: true, cameraInterrupted: true, sizeBytes: 0 });
  await expect(readFile(input.path)).rejects.toMatchObject({ code: 'ENOENT' });
}, 50_000);

it('does not produce a valid program when the scoreboard has never confirmed its data', async () => {
  const abort = new AbortController();
  ready = false;
  const input = options('overlay', abort.signal);
  const timer = setTimeout(() => abort.abort(), 2_500);
  let result;
  try { result = await probePilotMedia(input); }
  finally { clearTimeout(timer); ready = true; }
  expect(result).toMatchObject({ completed: false, overlayReceived: false, frames: 0, sizeBytes: 0 });
  await expect(readFile(input.path)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);
