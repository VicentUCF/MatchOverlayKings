import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';

export type PublicationReconcileTask = {
  readonly version: 1;
  readonly id: string;
  readonly kind: 'reconcile-publication';
  readonly jobId: string;
  readonly token: string;
  readonly attempt: number;
  readonly createdAt: string;
};

export type PublicationTaskOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'retry'; readonly delayMs: number; readonly resetAttempts?: boolean };

export type PublicationTaskHandler = (task: PublicationReconcileTask) => Promise<PublicationTaskOutcome>;
export type PublicationQueueEvent = {
  readonly type: 'connected' | 'disconnected' | 'reconnect-failed' | 'dead-lettered';
  readonly reason?: string;
};

export interface PublicationTaskQueue {
  start(handler: PublicationTaskHandler): Promise<void>;
  enqueue(jobId: string, token: string): Promise<void>;
  close(): Promise<void>;
}

const RETRY_DELAYS_MS = [5_000, 30_000, 5 * 60_000, 30 * 60_000] as const;
const DELAY_BUCKETS_MS = [...RETRY_DELAYS_MS, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;
const MAX_ATTEMPTS = 48;

export class InMemoryPublicationTaskQueue implements PublicationTaskQueue {
  private handler: PublicationTaskHandler | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  public async start(handler: PublicationTaskHandler): Promise<void> {
    this.handler = handler;
  }

  public async enqueue(jobId: string, token: string): Promise<void> {
    this.schedule(createTask(jobId, token), 0);
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(task: PublicationReconcileTask, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.run(task);
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private async run(task: PublicationReconcileTask): Promise<void> {
    if (this.closed || this.handler === null) return;
    try {
      const outcome = await this.handler(task);
      if (outcome.kind === 'retry' && (outcome.resetAttempts || task.attempt < MAX_ATTEMPTS)) {
        this.schedule({ ...task, attempt: outcome.resetAttempts ? 0 : task.attempt + 1 }, outcome.delayMs);
      }
    } catch {
      if (task.attempt < MAX_ATTEMPTS) {
        this.schedule({ ...task, attempt: task.attempt + 1 }, retryDelay(task.attempt));
      }
    }
  }
}

export class RabbitMqPublicationTaskQueue implements PublicationTaskQueue {
  private connection: ChannelModel | null = null;
  private publisher: ConfirmChannel | null = null;
  private consumer: Channel | null = null;
  private handler: PublicationTaskHandler | null = null;
  private closing = false;

  public constructor(
    private readonly url: string,
    private readonly prefix = 'kpl.publications',
    private readonly observe: (event: PublicationQueueEvent) => void = () => undefined,
  ) {}

  public async start(handler: PublicationTaskHandler): Promise<void> {
    if (this.connection !== null) return;
    this.handler = handler;
    const connection = await amqp.connect(this.url);
    try {
      const publisher = await connection.createConfirmChannel();
      const consumer = await connection.createChannel();
      await this.assertTopology(publisher);
      await consumer.prefetch(1);
      this.connection = connection;
      this.publisher = publisher;
      this.consumer = consumer;
      this.observe({ type: 'connected' });
      connection.on('error', () => undefined);
      connection.on('close', () => {
        this.connection = null;
        this.publisher = null;
        this.consumer = null;
        this.observe({ type: 'disconnected' });
        if (!this.closing) void this.reconnect();
      });
      await consumer.consume(this.mainQueue, (message) => {
        if (message !== null) void this.consume(message).catch(() => this.requeueLater(message));
      }, { noAck: false });
    } catch (error) {
      await connection.close().catch(() => undefined);
      this.connection = null;
      this.publisher = null;
      this.consumer = null;
      throw error;
    }
  }

  public async enqueue(jobId: string, token: string): Promise<void> {
    await this.publish(createTask(jobId, token), 0);
  }

  public async close(): Promise<void> {
    this.closing = true;
    const connection = this.connection;
    this.connection = null;
    this.publisher = null;
    this.consumer = null;
    if (connection !== null) await connection.close();
  }

  private get exchange(): string { return `${this.prefix}.exchange`; }
  private get deadExchange(): string { return `${this.prefix}.dead.exchange`; }
  private get mainQueue(): string { return `${this.prefix}.reconcile`; }
  private get deadQueue(): string { return `${this.prefix}.dead`; }

  private async reconnect(): Promise<void> {
    while (!this.closing && this.connection === null) {
      await delay(5_000);
      if (this.closing || this.handler === null) return;
      try { await this.start(this.handler); }
      catch { this.observe({ type: 'reconnect-failed' }); }
    }
  }

  private async assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(this.exchange, 'direct', { durable: true });
    await channel.assertExchange(this.deadExchange, 'fanout', { durable: true });
    await channel.assertQueue(this.mainQueue, { durable: true });
    await channel.bindQueue(this.mainQueue, this.exchange, 'reconcile');
    await channel.assertQueue(this.deadQueue, { durable: true });
    await channel.bindQueue(this.deadQueue, this.deadExchange, '');
    for (const delayMs of DELAY_BUCKETS_MS) {
      const queue = this.retryQueue(delayMs);
      await channel.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-message-ttl': delayMs,
          'x-dead-letter-exchange': this.exchange,
          'x-dead-letter-routing-key': 'reconcile',
        },
      });
      await channel.bindQueue(queue, this.exchange, `retry.${delayMs}`);
    }
  }

  private async consume(message: ConsumeMessage): Promise<void> {
    const consumer = this.consumer;
    if (consumer === null) return;
    const task = parseTask(message.content);
    if (task === null) {
      await this.deadLetter(message.content, 'invalid-message');
      consumer.ack(message);
      return;
    }
    try {
      const outcome = await this.handler?.(task) ?? { kind: 'retry' as const, delayMs: retryDelay(task.attempt) };
      if (outcome.kind === 'complete') {
        consumer.ack(message);
        return;
      }
      if (!outcome.resetAttempts && task.attempt >= MAX_ATTEMPTS) {
        await this.deadLetter(message.content, 'attempts-exhausted');
        consumer.ack(message);
        return;
      }
      await this.publish({ ...task, attempt: outcome.resetAttempts ? 0 : task.attempt + 1 }, outcome.delayMs);
      consumer.ack(message);
    } catch {
      // Requeue the original delivery. Publishing a replacement before acking is
      // handled above, so a broker failure cannot silently discard the task.
      this.requeueLater(message);
    }
  }

  private async publish(task: PublicationReconcileTask, requestedDelayMs: number): Promise<void> {
    const publisher = this.publisher;
    if (publisher === null) throw new Error('RabbitMQ publication queue is unavailable');
    const delayMs = requestedDelayMs <= 0 ? 0 : retryBucket(requestedDelayMs);
    publisher.publish(
      this.exchange,
      delayMs === 0 ? 'reconcile' : `retry.${delayMs}`,
      Buffer.from(JSON.stringify(task)),
      { contentType: 'application/json', deliveryMode: 2, messageId: task.id, timestamp: Date.now() },
    );
    await publisher.waitForConfirms();
  }

  private async deadLetter(content: Buffer, reason: string): Promise<void> {
    const publisher = this.publisher;
    if (publisher === null) throw new Error('RabbitMQ publication queue is unavailable');
    publisher.publish(this.deadExchange, '', content, {
      contentType: 'application/json', deliveryMode: 2, headers: { reason }, timestamp: Date.now(),
    });
    await publisher.waitForConfirms();
    this.observe({ type: 'dead-lettered', reason });
  }

  private retryQueue(delayMs: number): string { return `${this.prefix}.retry.${delayMs}`; }

  private requeueLater(message: ConsumeMessage): void {
    const consumer = this.consumer;
    if (consumer === null) return;
    const timer = setTimeout(() => {
      if (this.consumer === consumer) consumer.nack(message, false, true);
    }, 5_000);
    timer.unref();
  }
}

export function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)]!;
}

export function retryBucket(requestedDelayMs: number): number {
  if (requestedDelayMs <= RETRY_DELAYS_MS.at(-1)!) {
    return DELAY_BUCKETS_MS.find((candidate) => candidate >= requestedDelayMs) ?? RETRY_DELAYS_MS.at(-1)!;
  }
  return [...DELAY_BUCKETS_MS].reverse().find((candidate) => candidate <= requestedDelayMs) ?? DELAY_BUCKETS_MS[0];
}

function createTask(jobId: string, token: string): PublicationReconcileTask {
  return {
    version: 1,
    id: randomUUID(),
    kind: 'reconcile-publication',
    jobId,
    token,
    attempt: 0,
    createdAt: new Date().toISOString(),
  };
}

function parseTask(content: Buffer): PublicationReconcileTask | null {
  try {
    const value = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
    return value.version === 1
      && typeof value.id === 'string'
      && value.kind === 'reconcile-publication'
      && typeof value.jobId === 'string'
      && typeof value.token === 'string'
      && Number.isInteger(value.attempt)
      && Number(value.attempt) >= 0
      && typeof value.createdAt === 'string'
      ? value as PublicationReconcileTask
      : null;
  } catch {
    return null;
  }
}
