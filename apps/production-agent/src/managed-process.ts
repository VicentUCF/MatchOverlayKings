import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { Fd4PumpError, pumpFd4Input } from './fd4-pump.js';
import type { ProcessCommandPlan } from './process-command-plan.js';
import { BoundedProgressQueue } from './progress-queue.js';

export type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
export type ProcessSignalResult =
  | { readonly state: 'delivered' }
  | { readonly state: 'alreadyClosed' }
  | { readonly state: 'failed' };
export type ProcessCloseStatus = {
  readonly code: number | null;
  readonly signal: ProcessSignal | 'OTHER' | null;
};
export type ManagedProcessStatus =
  | { readonly state: 'running' }
  | { readonly state: 'closed'; readonly close: ProcessCloseStatus };
export type ProcessDiagnostics = {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly warningChunks: number;
  readonly errorChunks: number;
  readonly streamErrors: number;
  readonly progressQueuedBytes: number;
  readonly progressQueuedItems: number;
  readonly progressDroppedBytes: number;
  readonly progressDroppedItems: number;
  readonly progressCoalescedItems: number;
  readonly fd4DrainListeners: number;
  readonly fd4ErrorListeners: number;
  readonly fd4CloseListeners: number;
};
export interface ManagedProcessPort {
  readonly close: Promise<ProcessCloseStatus>;
  readonly progress: AsyncIterable<Uint8Array> | null;
  readonly diagnostics: () => ProcessDiagnostics;
  readonly pumpFd4: (chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<void>;
  readonly signal: (signal: ProcessSignal) => ProcessSignalResult;
  readonly status: () => ManagedProcessStatus;
  readonly releaseHandles: () => void;
}
export interface ProcessSpawnerPort {
  readonly spawn: (plan: ProcessCommandPlan) => Promise<ManagedProcessPort>;
}
export type ProcessAdapterErrorCode =
  | 'ABORTED' | 'FD3_UNAVAILABLE' | 'FD4_ALREADY_OWNED'
  | 'FD4_CLOSED' | 'FD4_UNAVAILABLE' | 'INPUT_FAILED' | 'SPAWN_FAILED';
const errorMessages = {
  ABORTED: 'Managed process input aborted',
  FD3_UNAVAILABLE: 'Managed process progress descriptor is unavailable',
  FD4_ALREADY_OWNED: 'Managed process input already has an owner',
  FD4_CLOSED: 'Managed process input descriptor closed',
  FD4_UNAVAILABLE: 'Managed process input descriptor is unavailable',
  INPUT_FAILED: 'Managed process input failed',
  SPAWN_FAILED: 'Managed process failed to spawn',
} as const satisfies Record<ProcessAdapterErrorCode, string>;
export class ProcessAdapterError extends Error {
  public constructor(public readonly code: ProcessAdapterErrorCode) {
    super(errorMessages[code]);
    this.name = 'ProcessAdapterError';
  }
}

function closeSignal(signal: NodeJS.Signals | null): ProcessCloseStatus['signal'] {
  switch (signal) {
    case null: return null;
    case 'SIGINT': return 'SIGINT';
    case 'SIGTERM': return 'SIGTERM';
    case 'SIGKILL': return 'SIGKILL';
    default: return 'OTHER';
  }
}

class NodeManagedProcess implements ManagedProcessPort {
  public readonly close: Promise<ProcessCloseStatus>;
  public readonly progress: AsyncIterable<Uint8Array> | null;
  private readonly progressQueue: BoundedProgressQueue | null;
  private closeStatus: ProcessCloseStatus | null = null;
  private fd4Owned = false;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private warningChunks = 0;
  private errorChunks = 0;
  private streamErrors = 0;

  public constructor(private readonly child: ChildProcess) {
    this.close = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        const status = Object.freeze({ code, signal: closeSignal(signal) });
        this.closeStatus = status;
        resolve(status);
      });
    });
    this.progressQueue = child.stdio[3] instanceof Readable
      ? new BoundedProgressQueue(child.stdio[3]) : null;
    this.progress = this.progressQueue;
    this.drain(child.stdout, 'stdout');
    this.drain(child.stderr, 'stderr');
    child.on('error', () => { this.streamErrors += 1; });
  }

  public diagnostics = (): ProcessDiagnostics => {
    const progress = this.progressQueue?.telemetry();
    return Object.freeze({
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      warningChunks: this.warningChunks,
      errorChunks: this.errorChunks,
      streamErrors: this.streamErrors,
      progressQueuedBytes: progress?.queuedBytes ?? 0,
      progressQueuedItems: progress?.queuedItems ?? 0,
      progressDroppedBytes: progress?.droppedBytes ?? 0,
      progressDroppedItems: progress?.droppedItems ?? 0,
      progressCoalescedItems: progress?.coalescedItems ?? 0,
      fd4DrainListeners: this.fd4()?.listenerCount('drain') ?? 0,
      fd4ErrorListeners: this.fd4()?.listenerCount('error') ?? 0,
      fd4CloseListeners: this.fd4()?.listenerCount('close') ?? 0,
    });
  };

  public pumpFd4 = async (chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> => {
    if (this.fd4Owned) throw new ProcessAdapterError('FD4_ALREADY_OWNED');
    this.fd4Owned = true;
    try {
      const input = this.fd4();
      if (input === null) throw new ProcessAdapterError('FD4_UNAVAILABLE');
      await pumpFd4Input({ input, chunks, signal, childClose: this.close });
    } catch (error) {
      if (error instanceof ProcessAdapterError) throw error;
      if (error instanceof Fd4PumpError) throw new ProcessAdapterError(error.code);
      throw new ProcessAdapterError('INPUT_FAILED');
    } finally {
      this.fd4Owned = false;
    }
  };

  public signal = (signal: ProcessSignal): ProcessSignalResult => {
    if (this.closeStatus !== null) return { state: 'alreadyClosed' };
    try {
      return this.child.kill(signal) ? { state: 'delivered' } : { state: 'failed' };
    } catch (error) {
      if (error instanceof Error) return { state: 'failed' };
      return { state: 'failed' };
    }
  };

  public status = (): ManagedProcessStatus => this.closeStatus === null
    ? { state: 'running' } : { state: 'closed', close: this.closeStatus };

  public releaseHandles = (): void => {
    for (const stream of this.child.stdio) stream?.destroy();
    this.child.unref();
  };

  private fd4(): Writable | null {
    const input = this.child.stdio[4];
    return input instanceof Writable ? input : null;
  }

  private drain(stream: Readable | null, source: 'stdout' | 'stderr'): void {
    if (stream === null) return;
    stream.on('data', (chunk: Buffer) => {
      if (source === 'stdout') this.stdoutBytes += chunk.byteLength;
      else this.stderrBytes += chunk.byteLength;
      const category = chunk.toString('utf8').toLowerCase();
      if (category.includes('warning')) this.warningChunks += 1;
      if (category.includes('error')) this.errorChunks += 1;
    });
    stream.on('error', () => { this.streamErrors += 1; });
  }
}

export class NodeProcessSpawner implements ProcessSpawnerPort {
  public spawn = (plan: ProcessCommandPlan): Promise<ManagedProcessPort> => {
    const child = spawn(plan.executable, plan.argv, {
      cwd: plan.cwd, env: plan.env, shell: false, stdio: [...plan.stdio],
    });
    return new Promise((resolve, reject) => {
      const rejectSpawn = (): void => reject(new ProcessAdapterError('SPAWN_FAILED'));
      child.once('error', rejectSpawn);
      child.once('spawn', () => {
        child.off('error', rejectSpawn);
        resolve(new NodeManagedProcess(child));
      });
    });
  };
}
