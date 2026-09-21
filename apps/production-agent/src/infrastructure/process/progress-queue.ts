import type { Readable } from 'node:stream';

const MAX_QUEUED_BYTES = 65_536;

export type ProgressQueueTelemetry = {
  readonly queuedBytes: number;
  readonly queuedItems: number;
  readonly droppedBytes: number;
  readonly droppedItems: number;
  readonly coalescedItems: number;
};

export type ProgressStreamErrorCode =
  | 'PROGRESS_CONSUMER_BUSY'
  | 'PROGRESS_READ_PENDING'
  | 'PROGRESS_SOURCE_FAILED';

const progressErrorMessages = {
  PROGRESS_CONSUMER_BUSY: 'Managed process progress already has a consumer',
  PROGRESS_READ_PENDING: 'Managed process progress read already pending',
  PROGRESS_SOURCE_FAILED: 'Managed process progress stream failed',
} as const satisfies Record<ProgressStreamErrorCode, string>;

export class ProgressStreamError extends Error {
  public constructor(public readonly code: ProgressStreamErrorCode) {
    super(progressErrorMessages[code]);
    this.name = 'ProgressStreamError';
  }
}

type Consumer = Readonly<Record<never, never>>;
type Waiter = {
  readonly consumer: Consumer;
  readonly resolve: (result: IteratorResult<Uint8Array>) => void;
  readonly reject: (error: ProgressStreamError) => void;
};

export class BoundedProgressQueue implements AsyncIterable<Uint8Array> {
  private queued: Uint8Array | null = null;
  private consumer: Consumer | null = null;
  private waiter: Waiter | null = null;
  private ended = false;
  private failed = false;
  private droppedBytes = 0;
  private droppedItems = 0;
  private coalescedItems = 0;

  public constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => { this.push(new Uint8Array(chunk)); });
    stream.once('end', () => { this.end(); });
    stream.once('close', () => { this.end(); });
    stream.once('error', () => { this.fail(); });
  }

  public telemetry(): ProgressQueueTelemetry {
    return Object.freeze({
      queuedBytes: this.queued?.byteLength ?? 0,
      queuedItems: this.queued === null ? 0 : 1,
      droppedBytes: this.droppedBytes,
      droppedItems: this.droppedItems,
      coalescedItems: this.coalescedItems,
    });
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const consumer = Object.freeze({});
    let active = true;
    return {
      next: async () => {
        if (!active) return { done: true, value: undefined };
        const result = await this.next(consumer);
        if (result.done) active = false;
        return result;
      },
      return: () => {
        active = false;
        this.release(consumer);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private push(chunk: Uint8Array): void {
    if (this.ended) return;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter.resolve({ done: false, value: chunk });
      return;
    }
    const existing = this.queued;
    if (existing === null) {
      this.queued = chunk.byteLength <= MAX_QUEUED_BYTES
        ? chunk
        : this.trim(chunk, chunk.byteLength - MAX_QUEUED_BYTES);
      return;
    }
    const combined = new Uint8Array(existing.byteLength + chunk.byteLength);
    combined.set(existing);
    combined.set(chunk, existing.byteLength);
    this.coalescedItems += 1;
    this.queued = combined.byteLength <= MAX_QUEUED_BYTES
      ? combined
      : this.trim(combined, combined.byteLength - MAX_QUEUED_BYTES);
  }

  private trim(chunk: Uint8Array, count: number): Uint8Array {
    this.droppedBytes += count;
    this.droppedItems += 1;
    return chunk.slice(count);
  }

  private next(consumer: Consumer): Promise<IteratorResult<Uint8Array>> {
    if (this.consumer !== null && this.consumer !== consumer) {
      return Promise.reject(new ProgressStreamError('PROGRESS_CONSUMER_BUSY'));
    }
    this.consumer = consumer;
    if (this.waiter !== null) {
      return Promise.reject(new ProgressStreamError('PROGRESS_READ_PENDING'));
    }
    if (this.failed) {
      this.consumer = null;
      return Promise.reject(new ProgressStreamError('PROGRESS_SOURCE_FAILED'));
    }
    const queued = this.queued;
    if (queued !== null) {
      this.queued = null;
      return Promise.resolve({ done: false, value: queued });
    }
    if (this.ended) {
      this.consumer = null;
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => { this.waiter = { consumer, resolve, reject }; });
  }

  private release(consumer: Consumer): void {
    if (this.consumer !== consumer) return;
    this.consumer = null;
    const waiter = this.waiter;
    if (waiter?.consumer === consumer) {
      this.waiter = null;
      waiter.resolve({ done: true, value: undefined });
    }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.consumer = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve({ done: true, value: undefined });
  }

  private fail(): void {
    if (this.ended) return;
    this.failed = true;
    this.ended = true;
    this.consumer = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(new ProgressStreamError('PROGRESS_SOURCE_FAILED'));
  }
}
