import type { FfmpegCourtGeneration } from './ffmpeg-court-generation.js';
import { MediaInspectionFailure } from './ffmpeg-court-monitor.js';
import { FfmpegCourtPipelineError, type FfmpegCourtPipelineErrorCode } from './ffmpeg-court-pipeline-model.js';
import type { ManagedProcessPort } from './managed-process.js';
import type { SchedulerPort } from './process-stop.js';

type StartupTermination = Extract<FfmpegCourtPipelineErrorCode, 'START_ABORTED' | 'START_TIMEOUT'>;

export type StartupRace<Value> =
  | { readonly kind: 'value'; readonly value: Value }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'terminated'; readonly code: StartupTermination };

type StartupDeadlineOptions = {
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal;
  readonly scheduler: SchedulerPort;
  readonly timeoutMs: number;
};

export class FfmpegCourtStartupDeadline {
  readonly #controller: AbortController;
  readonly #timeoutController = new AbortController();
  readonly #terminated: Promise<void>;
  readonly #detachExternal: () => void;
  #code: StartupTermination | null = null;

  public constructor(options: StartupDeadlineOptions) {
    this.#controller = options.controller;
    const abort = (): void => { this.terminate('START_ABORTED'); };
    if (options.externalSignal.aborted) abort();
    else options.externalSignal.addEventListener('abort', abort, { once: true });
    this.#detachExternal = () => { options.externalSignal.removeEventListener('abort', abort); };
    this.#terminated = abortPromise(this.#controller.signal);
    const timeout = options.scheduler.wait(options.timeoutMs, this.#timeoutController.signal);
    void timeout.then(() => {
      if (!this.#timeoutController.signal.aborted) this.terminate('START_TIMEOUT');
    });
  }

  public get code(): StartupTermination | null { return this.#code; }

  public async race<Value>(operation: Promise<Value>): Promise<StartupRace<Value>> {
    return Promise.race([
      operation.then(
        (value): StartupRace<Value> => ({ kind: 'value', value }),
        (error: unknown): StartupRace<Value> => ({ kind: 'failed', error }),
      ),
      this.#terminated.then<StartupRace<Value>>(() => ({
        kind: 'terminated',
        code: this.#code ?? 'START_ABORTED',
      })),
    ]);
  }

  public async waitFor(operation: Promise<void>): Promise<void> {
    const result = await this.race(operation);
    switch (result.kind) {
      case 'value': return;
      case 'failed': throw result.error;
      case 'terminated': throw new FfmpegCourtPipelineError(result.code);
      default: return assertNever(result);
    }
  }

  public async awaitReadiness(generation: FfmpegCourtGeneration): Promise<void> {
    const result = await Promise.race([
      generation.ready.then(() => 'ready' as const),
      generation.failed,
      this.#terminated.then(() => this.#code ?? 'START_ABORTED'),
    ]);
    if (result !== 'ready') throw new FfmpegCourtPipelineError(result);
  }

  public throwIfTerminated(): void {
    if (this.#code !== null) throw new FfmpegCourtPipelineError(this.#code);
  }

  public dispose(): void {
    this.#detachExternal();
    this.#timeoutController.abort();
  }

  private terminate(code: StartupTermination): void {
    if (this.#code !== null) return;
    this.#code = code;
    this.#controller.abort();
  }
}

export function unwrapSpawn(result: StartupRace<ManagedProcessPort>): ManagedProcessPort {
  switch (result.kind) {
    case 'value': return result.value;
    case 'failed': throw result.error;
    case 'terminated': throw new FfmpegCourtPipelineError(result.code);
    default: return assertNever(result);
  }
}

export function mapFfmpegStartError(
  error: unknown,
  generation: FfmpegCourtGeneration,
): FfmpegCourtPipelineErrorCode {
  if (generation.startupController.signal.aborted) return 'START_ABORTED';
  if (error instanceof FfmpegCourtPipelineError) return error.code;
  if (error instanceof MediaInspectionFailure) return 'MEDIA_FAILED';
  if (generation.process === null) return 'PROCESS_FAILED';
  return generation.fault ?? 'PROCESS_FAILED';
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); });
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected startup result: ${String(value)}`);
}
