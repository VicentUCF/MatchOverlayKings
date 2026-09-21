import { describe, expect, it } from 'vitest';
import { retryBucket, retryDelay } from '../src/publication-task-queue.js';

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
});
