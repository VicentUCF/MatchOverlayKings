import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { PilotSource } from '@kpl/production-contracts';
import { ffmpegEnvironment } from './pilot-video-encoder.js';

export type ProgramSourceState = { readonly active: boolean; readonly attempt: number; readonly exhausted: boolean; readonly reason: string | null };
export interface ProgramFeed {
  readonly captureProcess: ChildProcess | null;
  start(video: Writable, audio: Writable): Promise<void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}
export type ProgramFeedOptions = {
  readonly executable: string;
  readonly source: PilotSource;
  readonly mobileRtspUrl: string | null;
  readonly mobileAudioAvailable: boolean;
  readonly sourceReady: () => boolean;
  readonly fps: 30 | 60;
  readonly fallback: Uint8Array;
  readonly onState: (state: ProgramSourceState) => void;
  readonly onProcess: () => void;
  readonly width?: number;
  readonly height?: number;
  /** A local validation must never count generated continuity as camera input. */
  readonly requireSource?: boolean;
};

const RETRIES = [1_000, 2_000, 4_000, 8_000, 15_000];

/** An encoder clock independent of camera availability, with bounded, paired A/V queues. */
export class PilotProgramFeed implements ProgramFeed {
  public captureProcess: ChildProcess | null = null;
  private readonly abort = new AbortController();
  private readonly video: FrameQueue;
  private readonly audio: FrameQueue;
  private readonly silence: Buffer;
  private lastFrame: Uint8Array;
  private lastPairAt = 0;
  private captureStartedAt = 0;
  private sourceStableSince: number | null = null;
  private active = true;
  private attempts = 0;
  private exhausted = false;
  private retry: NodeJS.Timeout | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private retiring = false;
  private pumping: Promise<void> | null = null;
  private outputs: readonly Writable[] = [];
  private reported = '';

  public constructor(private readonly options: ProgramFeedOptions) {
    const size = (options.width ?? 1920) * (options.height ?? 1080) * 3 / 2;
    if (options.fallback.byteLength !== size) throw new Error('Invalid continuity frame size');
    this.video = new FrameQueue(size, 6);
    // PCM arrives in bursts ahead of video. Six audio chunks discarded valid
    // partners before their video frame arrived, reducing a 30 fps source to ~22.
    // One second costs only 192 KB; the expensive video queue stays at six frames.
    this.audio = new FrameQueue(48_000 / options.fps * 4, options.fps);
    this.silence = Buffer.alloc(48_000 / options.fps * 4);
    this.lastFrame = options.fallback;
  }

  public start(video: Writable, audio: Writable): Promise<void> {
    if (this.pumping) throw new Error('Program feed already started');
    // A pipe can report EPIPE after an aborted write callback has already settled.
    // The active write promise handles failures; late shutdown errors are harmless.
    video.on('error', () => undefined); audio.on('error', () => undefined);
    this.outputs = [video, audio];
    this.emit('Esperando señal de cámara; se muestra la continuidad.');
    this.capture();
    this.pumping = this.pump(video, audio);
    return this.pumping;
  }

  public async recover(): Promise<void> {
    if (this.abort.signal.aborted) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.attempts = 0;
    this.exhausted = false;
    await this.stopCapture();
    this.capture();
  }

  public async close(): Promise<void> {
    this.abort.abort();
    // EOF must reach both input readers even if FFmpeg is blocked on one pipe.
    for (const output of this.outputs) output.destroy();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    await this.stopCapture();
    await this.pumping?.catch(() => undefined);
  }

  private capture(): void {
    if (this.abort.signal.aborted || this.captureProcess !== null) return;
    this.video.clear(); this.audio.clear();
    this.lastPairAt = 0; this.captureStartedAt = performance.now(); this.sourceStableSince = null;
    if (!this.options.sourceReady()) { this.failed('La cámara no está disponible. Se conserva la continuidad.'); return; }
    const child = spawn(this.options.executable, captureArguments(this.options), {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: ffmpegEnvironment(),
    });
    this.captureProcess = child;
    this.options.onProcess();
    child.stdout!.on('data', (chunk: Buffer) => { if (this.captureProcess === child && !this.retiring) this.video.push(chunk); });
    const audio = child.stdio[3] as Readable;
    audio.on('data', (chunk: Buffer) => { if (this.captureProcess === child && !this.retiring) this.audio.push(chunk); });
    child.stderr!.resume();
    child.once('error', () => { /* close owns the bounded retry; raw diagnostics can contain credentials. */ });
    child.once('close', () => {
      if (this.captureProcess !== child || this.retiring) return;
      this.captureProcess = null;
      this.options.onProcess();
      this.failed('La captura se interrumpió. Se conserva la continuidad y el marcador.');
    });
  }

  private failed(reason: string): void {
    if (this.abort.signal.aborted || this.retry !== null) return;
    this.active = true;
    this.lastFrame = this.options.fallback;
    this.video.clear(); this.audio.clear();
    const delay = RETRIES[this.attempts];
    this.exhausted = delay === undefined;
    this.emit(this.exhausted ? 'La cámara no se recuperó tras cinco intentos. Continúa la continuidad; comprueba la fuente y pulsa Recuperar emisión.' : reason);
    if (delay === undefined) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.attempts += 1;
      this.capture();
    }, delay);
    this.retry.unref();
  }

  private async pump(video: Writable, audio: Writable): Promise<void> {
    const frameMs = 1_000 / this.options.fps;
    let next = performance.now();
    while (!this.abort.signal.aborted && !video.destroyed && !audio.destroyed) {
      const now = performance.now();
      const pair = this.pair();
      let sound: Uint8Array = this.silence;
      if (pair) {
        this.lastFrame = pair.video; sound = pair.audio; this.lastPairAt = now;
        this.sourceStableSince ??= now;
        if (now - this.sourceStableSince >= 30_000) this.attempts = 0;
        this.active = false; this.exhausted = false; this.emit(null);
      } else if (this.captureProcess !== null && !this.retiring && now - (this.lastPairAt || this.captureStartedAt) >= (this.lastPairAt ? 2_000 : 8_000)) {
        this.active = true; this.lastFrame = this.options.fallback;
        this.emit('La cámara dejó de entregar señal. Se conserva la continuidad y el marcador.');
        void this.stopCapture().then(() => this.failed('Reintentando la cámara mientras se mantiene la continuidad.')).catch(() => {
          this.exhausted = true;
          this.emit('No se pudo detener la captura anterior. Continúa la continuidad; revisa la fuente antes de recuperar.');
        });
      }
      if (!this.options.requireSource || pair) {
        await Promise.all([writeFrame(video, this.lastFrame, this.abort.signal), writeFrame(audio, sound, this.abort.signal)]);
      }
      next = Math.max(next + frameMs, performance.now());
      await wait(Math.max(0, next - performance.now()), this.abort.signal);
    }
  }

  private pair(): { video: Buffer; audio: Buffer } | null {
    while (this.video.first && this.audio.first) {
      if (this.video.first.index < this.audio.first.index) { this.video.shift(); continue; }
      if (this.audio.first.index < this.video.first.index) { this.audio.shift(); continue; }
      return { video: this.video.shift()!.bytes, audio: this.audio.shift()!.bytes };
    }
    return null;
  }

  private emit(reason: string | null): void {
    const state = { active: this.active, attempt: this.attempts, exhausted: this.exhausted, reason };
    const fingerprint = JSON.stringify(state);
    if (fingerprint !== this.reported) { this.reported = fingerprint; this.options.onState(state); }
  }

  private stopCapture(): Promise<void> {
    const child = this.captureProcess;
    if (!child || this.retiring) return this.stopping;
    // Retain process identity until it actually closes, but ignore its late media.
    this.retiring = true;
    this.video.clear(); this.audio.clear();
    this.stopping = new Promise<void>((resolve, reject) => {
      let settled = false;
      let forced: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        forced = setTimeout(() => { this.retiring = false; reject(new Error('Capture did not stop')); }, 1_000); forced.unref();
        child.kill('SIGKILL');
      }, 1_000);
      timer.unref();
      const closed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(forced); this.captureProcess = null; this.retiring = false;
        this.options.onProcess(); resolve();
      };
      child.once('close', closed);
      if (child.exitCode !== null || child.signalCode !== null) closed();
      else child.kill('SIGTERM');
    });
    return this.stopping;
  }
}

class FrameQueue {
  private pending: Buffer;
  private used = 0;
  private index = 0;
  private frames: Array<{ index: number; bytes: Buffer }> = [];
  public constructor(private readonly size: number, private readonly maximum: number) { this.pending = Buffer.allocUnsafe(size); }
  public get first() { return this.frames[0]; }
  public shift() { return this.frames.shift(); }
  public clear() { this.used = 0; this.index = 0; this.frames = []; }
  public push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const length = Math.min(chunk.length - offset, this.size - this.used);
      chunk.copy(this.pending, this.used, offset, offset + length);
      this.used += length; offset += length;
      if (this.used === this.size) {
        this.frames.push({ index: this.index++, bytes: this.pending });
        if (this.frames.length > this.maximum) this.frames.shift();
        this.pending = Buffer.allocUnsafe(this.size); this.used = 0;
      }
    }
  }
}

export function captureArguments(options: ProgramFeedOptions): string[] {
  const { source, fps } = options;
  const input = source.kind === 'synthetic' ? ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${options.width ?? 1920}x${options.height ?? 1080}:rate=${fps}`]
    : source.kind === 'v4l2' ? ['-thread_queue_size', '8', '-f', 'v4l2', '-framerate', '30', '-video_size', '1920x1080', '-i', source.devicePath]
      : ['-rtsp_transport', 'tcp', '-timeout', '5000000', '-thread_queue_size', '8', '-i', options.mobileRtspUrl!];
  const hasAudio = source.kind === 'mobile' && options.mobileAudioAvailable;
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', ...input,
    ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
    '-map', '0:v:0', '-vf', `scale=${options.width ?? 1920}:${options.height ?? 1080}:out_color_matrix=bt709:out_range=tv,fps=${fps},format=yuv420p`,
    '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', 'pipe:1',
    '-map', hasAudio ? '0:a:0' : '1:a:0', '-af', 'aresample=async=1000:first_pts=0',
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:3'];
}

function writeFrame(output: Writable, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted || output.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); resolve(); };
    const error = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { signal.removeEventListener('abort', aborted); output.off('error', error); };
    signal.addEventListener('abort', aborted, { once: true });
    output.once('error', error);
    output.write(bytes, (error) => { cleanup(); if (error && !signal.aborted) reject(error); else resolve(); });
  });
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}
