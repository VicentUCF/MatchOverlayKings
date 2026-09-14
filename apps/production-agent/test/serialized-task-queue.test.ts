import { describe, expect, it } from 'vitest';
import { SerializedTaskQueue } from '../src/serialized-task-queue.js';

describe('SerializedTaskQueue', () => {
  it('recovers its tail after a non-Error rejection while preserving the rejection', async () => {
    const queue = new SerializedTaskQueue();

    const rejected = queue.run(() => Promise.reject('synthetic rejection'));
    await expect(rejected).rejects.toBe('synthetic rejection');
    const recovered = await queue.run(async () => 'recovered');

    expect(recovered).toBe('recovered');
  });
});
