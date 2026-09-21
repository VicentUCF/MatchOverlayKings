import { EventEmitter } from 'node:events';
import type { Channel, ChannelModel, ConfirmChannel } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import { RabbitMqPublicationTaskQueue, retryBucket, retryDelay } from '../src/infrastructure/queues/publication-task-queue.js';

describe('publication task retry policy', () => {
  it('backs transient failures off to a bounded thirty-minute cadence', () => {
    expect([0, 1, 2, 3, 20].map(retryDelay)).toEqual([
      5_000, 30_000, 5 * 60_000, 30 * 60_000, 30 * 60_000,
    ]);
  });

  it('uses durable TTL buckets without delaying long scheduled publications by more than a bucket', () => {
    expect(retryBucket(10_000)).toBe(30_000);
    expect(retryBucket(3 * 60 * 60_000)).toBe(60 * 60_000);
    expect(retryBucket(2 * 24 * 60 * 60_000)).toBe(24 * 60 * 60_000);
  });

  it('keeps startup degraded and reconnects after the broker becomes available', async () => {
    const events: string[] = [];
    const connection = fakeConnection();
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValueOnce(connection.value);
    const queue = new RabbitMqPublicationTaskQueue(
      'amqp://test', 'test.publications', (event) => events.push(event.type), 0, connect,
    );

    await expect(queue.start(async () => ({ kind: 'complete' }))).resolves.toBeUndefined();
    await waitUntil(() => events.includes('connected'));

    expect(events).toEqual(['reconnect-failed', 'connected']);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connection.publisher.assertExchange).toHaveBeenCalledWith('test.publications.exchange', 'direct', { durable: true });
    expect(connection.publisher.assertExchange).toHaveBeenCalledWith('test.publications.dead.exchange', 'fanout', { durable: true });
    expect(connection.publisher.assertQueue).toHaveBeenCalledWith('test.publications.reconcile', { durable: true });
    expect(connection.publisher.assertQueue).toHaveBeenCalledWith(
      'test.publications.retry.5000',
      expect.objectContaining({ arguments: expect.objectContaining({ 'x-message-ttl': 5_000 }) }),
    );
    await queue.close();
  });

  it('rebuilds both channels when either RabbitMQ channel closes', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const events: string[] = [];
    const connect = vi.fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const queue = new RabbitMqPublicationTaskQueue(
      'amqp://test', 'test.publications', (event) => events.push(`${event.type}:${event.reason ?? ''}`), 0, connect,
    );

    await queue.start(async () => ({ kind: 'complete' }));
    first.publisher.emit('close');
    await waitUntil(() => connect.mock.calls.length === 2
      && events.filter((event) => event === 'connected:').length === 2);

    expect(events).toContain('disconnected:publisher-channel-closed');
    expect(first.close).toHaveBeenCalled();
    expect(second.consumer.consume).toHaveBeenCalledOnce();
    await queue.close();
  });
});

function fakeConnection() {
  const publisher = Object.assign(new EventEmitter(), {
    assertExchange: vi.fn(async () => ({})), assertQueue: vi.fn(async () => ({})), bindQueue: vi.fn(async () => ({})),
    publish: vi.fn(() => true), waitForConfirms: vi.fn(async () => undefined),
  });
  const consumer = Object.assign(new EventEmitter(), {
    prefetch: vi.fn(async () => ({})), consume: vi.fn(async () => ({ consumerTag: 'test' })),
    ack: vi.fn(), nack: vi.fn(),
  });
  const close = vi.fn(async () => undefined);
  const value = Object.assign(new EventEmitter(), {
    createConfirmChannel: vi.fn(async () => publisher as unknown as ConfirmChannel),
    createChannel: vi.fn(async () => consumer as unknown as Channel), close,
  }) as unknown as ChannelModel;
  return { value, publisher, consumer, close };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for RabbitMQ queue state.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
