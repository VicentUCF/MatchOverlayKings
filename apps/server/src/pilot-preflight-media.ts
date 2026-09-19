import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { PilotOverlayHealth, PilotSignalHealth, PilotVideoEncoder } from '@kpl/production-contracts';
import type { PilotOverlayOptions, PilotOverlayRenderer } from './pilot-overlay.js';
import { PilotProgramFeed, type ProgramFeedOptions } from './pilot-program-feed.js';
import { pilotProgramCommand } from './pilot-program-command.js';
import { PilotSignalMonitor } from './pilot-signal-monitor.js';
import { ffmpegEnvironment, isHardwareEncoderFailure } from './pilot-video-encoder.js';

export type PilotMediaProbeOptions = {
  readonly path: string;
  readonly source: Omit<ProgramFeedOptions, 'onState' | 'onProcess' | 'requireSource'>;
  readonly encoder: PilotVideoEncoder;
  readonly overlay: Omit<PilotOverlayOptions, 'onState'>;
  readonly renderer: PilotOverlayRenderer;
  readonly audioExpected: boolean;
  readonly signal: AbortSignal;
  readonly onProcess?: (encoder: ChildProcess | null, capture: ChildProcess | null) => void;
};
export type PilotMediaProbeResult = {
  readonly completed: boolean;
  readonly cameraReceived: boolean;
  readonly cameraInterrupted: boolean;
  readonly overlayReceived: boolean;
  readonly overlayInterrupted: boolean;
  readonly hardwareFailure: boolean;
  readonly durationSeconds: number;
  readonly frames: number;
  readonly sizeBytes: number;
  readonly elapsedSeconds: number;
  readonly signal: PilotSignalHealth;
};

/** Ten seconds of the actual program, sent exclusively to a private local MP4. */
export async function probePilotMedia(options: PilotMediaProbeOptions): Promise<PilotMediaProbeResult> {
  options.signal.throwIfAborted();
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const deadline = setTimeout(abort, 45_000); deadline.unref();
  const monitor = new PilotSignalMonitor({ fps: options.source.fps, audioExpected: options.audioExpected, remoteOutput: false });
  let cameraReceived = false; let cameraInterrupted = false;
  let overlayReceived = false; let overlayInterrupted = false;
  let frames = 0; let durationSeconds = 0; let diagnostic = ''; let pending = '';
  let progress: Record<string, string> = {};
  let overlayHealth: PilotOverlayHealth | null = null;
  const command = pilotProgramCommand(options.source.executable, null, options.source.fps, options.encoder,
    { path: options.path, seconds: 10 });
  const started = performance.now();
  const child = spawn(command.executable, command.argv, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    env: ffmpegEnvironment(), windowsHide: true, shell: false,
  });
  const pipes = child.stdio as unknown as readonly (Readable | Writable)[];
  // Always consume errors, including late EPIPE after the preview encoder exits.
  for (const pipe of child.stdio) pipe?.on('error', () => undefined);
  let exited = false;
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => undefined);
    child.once('close', (code) => { exited = true; resolve(code); });
  });
  let force: NodeJS.Timeout | undefined;
  let feedStop: NodeJS.Timeout | undefined;
  const stop = () => {
    if (exited) return;
    child.kill('SIGTERM');
    force ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2_000);
    force.unref();
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  if (controller.signal.aborted) stop();
  const program = new PilotProgramFeed({ ...options.source, requireSource: true,
    onState: (state) => {
      if (exited || controller.signal.aborted) return;
      if (cameraReceived && state.active) cameraInterrupted = true;
      if (!state.active) cameraReceived = true;
    },
    onProcess: () => options.onProcess?.(exited ? null : child, program.captureProcess),
  });
  options.onProcess?.(child, null);
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    const lines = `${pending}${chunk}`.split(/\r?\n/); pending = (lines.pop() ?? '').slice(-300);
    for (const line of lines) {
      const at = line.indexOf('=');
      if (at <= 0 || line.length > 300) continue;
      progress[line.slice(0, at)] = line.slice(at + 1);
      if (line.startsWith('progress=')) {
        monitor.progress(progress);
        frames = numeric(progress.frame);
        durationSeconds = numeric(progress.out_time_us) / 1_000_000;
        progress = {};
      }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { diagnostic = `${diagnostic}${chunk}`.slice(-4_000); });
  for (const [fd, consume] of [[4, (chunk: string) => monitor.video(chunk)], [5, (chunk: string) => monitor.audio(chunk)]] as const) {
    const pipe = pipes[fd] as Readable;
    pipe.setEncoding('utf8'); pipe.on('data', consume);
  }
  const overlay = options.renderer.start(child.stdio[3] as Writable, { ...options.overlay,
    onState: (state) => {
      if (exited || controller.signal.aborted) return;
      if (overlayReceived && state.status !== 'ready') overlayInterrupted = true;
      if (state.status === 'ready' && state.lastFrameAt !== null) overlayReceived = true;
      overlayHealth = state;
    },
  }, controller.signal).catch(() => { if (!exited && !controller.signal.aborted) { overlayInterrupted = true; stop(); } });
  const feeding = program.start(pipes[6] as Writable, pipes[7] as Writable)
    .catch(() => { if (!exited && !controller.signal.aborted) {
      // The encoder can close its input before emitting close after its final MP4 frame.
      feedStop = setTimeout(() => { if (!exited) stop(); }, 500); feedStop.unref();
    } });
  let completed = false; let sizeBytes = 0; let measured = monitor.snapshot();
  try {
    const code = await closed;
    measured = monitor.snapshot();
    // This output is CFR. The AAC mux timestamp can run ahead and then truncate
    // at -t, understating speed in the last window despite 30/60 encoded fps.
    // Use actual encoded video frames per wall-clock second for this finite clip.
    measured = { ...measured, measuredSpeed: measured.measuredFramesPerSecond === null
      ? null : measured.measuredFramesPerSecond / options.source.fps };
    const currentOverlay = overlayHealth as PilotOverlayHealth | null;
    completed = code === 0 && !controller.signal.aborted && cameraReceived && !cameraInterrupted
      && overlayReceived && !overlayInterrupted && currentOverlay?.status === 'ready'
      && durationSeconds >= 9.8 && frames >= options.source.fps * 9.8;
    if (completed) {
      await chmod(options.path, 0o600);
      sizeBytes = (await stat(options.path)).size;
      completed = sizeBytes > 0 && await decodePreview(options.source.executable, options.path, controller.signal);
    }
  } catch {
    completed = false;
  } finally {
    clearTimeout(deadline);
    options.signal.removeEventListener('abort', abort);
    controller.abort();
    const cleanup = await Promise.allSettled([program.close(), overlay, feeding, closed]);
    clearTimeout(force);
    clearTimeout(feedStop);
    // A failed close must retain identity for restart cleanup; late close callbacks
    // clear it only after the actual process has gone away.
    options.onProcess?.(exited ? null : child, program.captureProcess);
    if (cleanup.some((result) => result.status === 'rejected')) completed = false;
    if (!completed) await rm(options.path, { force: true });
  }
  return { completed, cameraReceived, cameraInterrupted, overlayReceived, overlayInterrupted,
    hardwareFailure: options.encoder.hardware && isHardwareEncoderFailure(diagnostic),
    durationSeconds, frames, sizeBytes: completed ? sizeBytes : 0,
    elapsedSeconds: (performance.now() - started) / 1_000, signal: measured };
}

function numeric(value: string | undefined): number {
  const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0;
}
function decodePreview(executable: string, path: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(executable, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-i', path,
      '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], {
      env: ffmpegEnvironment(), timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 16_384, signal,
    }, (error) => resolve(error === null));
  });
}
