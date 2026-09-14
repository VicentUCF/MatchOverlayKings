import type {
  ManagedProcessPort,
  ProcessCloseStatus,
} from './managed-process.js';

export interface SchedulerPort {
  readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export type StopProcessOptions = {
  readonly process: ManagedProcessPort;
  readonly scheduler: SchedulerPort;
  readonly graceMs: number;
  readonly signal: AbortSignal;
};

export type ProcessStopErrorCode = 'SIGNAL_FAILED';

export class ProcessStopError extends Error {
  public constructor(public readonly code: ProcessStopErrorCode) {
    super('Failed to deliver process stop signal');
    this.name = 'ProcessStopError';
  }
}

type GraceResult =
  | { readonly state: 'closed'; readonly close: ProcessCloseStatus }
  | { readonly state: 'elapsed' }
  | { readonly state: 'aborted' };

export class NodeScheduler implements SchedulerPort {
  public wait = (delayMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delayMs);
    const cancel = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

async function waitForCloseOrGrace(options: StopProcessOptions): Promise<GraceResult> {
  if (options.signal.aborted) return { state: 'aborted' };
  const timerController = new AbortController();
  let resolveAbort: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
  options.signal.addEventListener('abort', resolveAbort, { once: true });
  const result = await Promise.race([
    options.process.close.then((close): GraceResult => ({ state: 'closed', close })),
    options.scheduler.wait(options.graceMs, timerController.signal)
      .then((): GraceResult => ({ state: 'elapsed' })),
    aborted.then((): GraceResult => ({ state: 'aborted' })),
  ]);
  timerController.abort();
  options.signal.removeEventListener('abort', resolveAbort);
  return result;
}

function deliverSignal(options: StopProcessOptions, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): boolean {
  const result = options.process.signal(signal);
  if (result.state === 'failed') throw new ProcessStopError('SIGNAL_FAILED');
  return result.state === 'delivered';
}

export async function stopFfmpeg(options: StopProcessOptions): Promise<ProcessCloseStatus> {
  const status = options.process.status();
  if (status.state === 'closed') return status.close;
  if (!deliverSignal(options, 'SIGTERM')) return options.process.close;
  const grace = await waitForCloseOrGrace(options);
  if (grace.state === 'closed') return grace.close;
  if (!deliverSignal(options, 'SIGKILL')) return options.process.close;
  return options.process.close;
}

export async function stopMediaMtx(options: StopProcessOptions): Promise<ProcessCloseStatus> {
  const status = options.process.status();
  if (status.state === 'closed') return status.close;
  if (!deliverSignal(options, 'SIGINT')) return options.process.close;
  const interruptGrace = await waitForCloseOrGrace(options);
  if (interruptGrace.state === 'closed') return interruptGrace.close;
  if (!deliverSignal(options, 'SIGTERM')) return options.process.close;
  const terminateGrace = await waitForCloseOrGrace(options);
  if (terminateGrace.state === 'closed') return terminateGrace.close;
  if (!deliverSignal(options, 'SIGKILL')) return options.process.close;
  return options.process.close;
}
