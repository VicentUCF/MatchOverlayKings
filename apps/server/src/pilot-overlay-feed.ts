import type { Writable } from 'node:stream';
import type { PilotOverlayHealth } from '@kpl/production-contracts';

const RETRIES = [1_000, 2_000, 4_000, 8_000, 15_000];
export type OverlayCapture = (frame: (png: Uint8Array) => void, signal: AbortSignal) => Promise<void>;

/** Keeps the encoder clock independent of browser navigation, crashes and retries. */
export class PilotOverlayFeed {
  private readonly lifetime = new AbortController();
  private attemptController: AbortController | null = null;
  private task: Promise<void> | null = null;
  private frame: Uint8Array | null = null;
  private lastFrameAt: string | null = null;
  private status: PilotOverlayHealth['status'] = 'starting';
  private attempt = 0;
  private stableSince: number | null = null;
  private restartRequested = false;
  private wake: (() => void) | null = null;

  public constructor(private readonly capture: OverlayCapture, private readonly fps: number,
    private readonly onState: (state: PilotOverlayHealth) => void) {}

  public start(output: Writable, signal: AbortSignal): Promise<void> {
    if (this.task) throw new Error('Overlay feed already running');
    const abort = () => { this.lifetime.abort(); this.attemptController?.abort(); this.wake?.(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    output.on('error', () => undefined);
    this.task = (async () => {
      const capture = this.runCaptures();
      try { await this.pump(output); }
      finally { abort(); await capture; signal.removeEventListener('abort', abort); }
    })();
    return this.task;
  }

  public recover(): void {
    if (this.lifetime.signal.aborted) return;
    this.restartRequested = true;
    this.attempt = 0;
    this.report('recovering', 'Se está recuperando el navegador del marcador.');
    this.attemptController?.abort(); this.wake?.();
  }

  public async close(): Promise<void> {
    this.lifetime.abort(); this.attemptController?.abort(); this.wake?.();
    await this.task;
  }

  private async runCaptures(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      this.restartRequested = false;
      const controller = new AbortController();
      this.attemptController = controller;
      this.stableSince = null;
      this.report(this.frame ? 'recovering' : 'starting', this.frame
        ? 'Se conserva la última imagen del marcador mientras se reconecta.' : 'Esperando el marcador del partido configurado.');
      let accepting = true;
      try {
        await this.capture((frame) => {
          if (!accepting || controller.signal.aborted || this.lifetime.signal.aborted) return;
          this.frame = frame;
          this.lastFrameAt = new Date().toISOString();
          this.stableSince ??= performance.now();
          if (this.status !== 'ready') this.report('ready', null);
        }, controller.signal);
      } catch { /* Browser diagnostics may contain request URLs; only bounded operator messages are exposed. */ }
      finally { accepting = false; }
      if (this.lifetime.signal.aborted) break;
      if (this.restartRequested) continue;
      const backoff = RETRIES[this.attempt];
      if (backoff === undefined) {
        this.report('failed', this.frame
          ? 'El marcador no se recuperó tras cinco intentos. Se conserva su última imagen; pulsa Recuperar emisión.'
          : 'No se pudo cargar el marcador tras cinco intentos. La salida espera; comprueba la conexión y pulsa Recuperar emisión.');
        if (!this.lifetime.signal.aborted && !this.restartRequested) await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = null;
        continue;
      }
      this.report('recovering', this.frame
        ? 'El navegador o los datos del marcador no responden. Se conserva su última imagen mientras se reintenta.'
        : 'El marcador todavía no está disponible. Se reintenta sin iniciar una salida sin marcador.');
      await wait(backoff, controller.signal);
      if (!this.restartRequested) this.attempt++;
    }
  }

  private async pump(output: Writable): Promise<void> {
    const signal = this.lifetime.signal;
    const frameMs = 1_000 / this.fps;
    let next = performance.now();
    while (!signal.aborted && !output.destroyed) {
      if (this.status === 'ready' && this.stableSince !== null && performance.now() - this.stableSince >= 30_000 && this.attempt > 0) {
        this.attempt = 0; this.report('ready', null);
      }
      if (this.frame) await writeFrame(output, this.frame, signal);
      next = Math.max(next + frameMs, performance.now());
      await wait(Math.max(0, next - performance.now()), signal);
    }
  }

  private report(status: PilotOverlayHealth['status'], reason: string | null): void {
    this.status = status;
    this.onState({ status, attempt: this.attempt, lastFrameAt: this.lastFrameAt,
      holdingLastFrame: status !== 'ready' && this.frame !== null, reason });
  }
}

function writeFrame(output: Writable, frame: Uint8Array, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || output.destroyed) { resolve(); return; }
    const cleanup = () => { signal.removeEventListener('abort', abort); output.off('error', failed); };
    const abort = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); if (signal.aborted) resolve(); else reject(error); };
    signal.addEventListener('abort', abort, { once: true }); output.once('error', failed);
    output.write(frame, (error) => { cleanup(); if (error && !signal.aborted) reject(error); else resolve(); });
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref();
    signal.addEventListener('abort', done, { once: true });
  });
}
