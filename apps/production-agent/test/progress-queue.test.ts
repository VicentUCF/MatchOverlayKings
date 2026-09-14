import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BoundedProgressQueue } from '../src/progress-queue.js';
import { bounded } from './managed-process-fixture.js';

describe('BoundedProgressQueue consumer ownership', () => {
  it('rejects a concurrent next call from the same iterator without losing the first read', async () => {
    const source = new PassThrough();
    const iterator = new BoundedProgressQueue(source)[Symbol.asyncIterator]();

    const first = iterator.next();
    const second = iterator.next();
    source.end();

    await expect(second).rejects.toMatchObject({ code: 'PROGRESS_READ_PENDING' });
    expect(await bounded(first)).toEqual({
      state: 'settled',
      value: { done: true, value: undefined },
    });
  });

  it('rejects a second concurrent iterator without overwriting the owner waiter', async () => {
    const source = new PassThrough();
    const queue = new BoundedProgressQueue(source);
    const firstIterator = queue[Symbol.asyncIterator]();
    const secondIterator = queue[Symbol.asyncIterator]();

    const first = firstIterator.next();
    const second = secondIterator.next();
    source.end(new Uint8Array([7]));

    await expect(second).rejects.toMatchObject({ code: 'PROGRESS_CONSUMER_BUSY' });
    expect(await first).toEqual({ done: false, value: new Uint8Array([7]) });
  });

  it('settles its pending read on return and permits a later consumer', async () => {
    const source = new PassThrough();
    const queue = new BoundedProgressQueue(source);
    const firstIterator = queue[Symbol.asyncIterator]();
    const pending = firstIterator.next();
    const returned = firstIterator.return?.();
    if (returned === undefined) throw new TypeError('Expected iterator return');

    await returned;
    expect(await bounded(pending)).toEqual({
      state: 'settled',
      value: { done: true, value: undefined },
    });
    source.end(new Uint8Array([9]));
    const laterIterator = queue[Symbol.asyncIterator]();
    expect(await laterIterator.next()).toEqual({ done: false, value: new Uint8Array([9]) });
    expect(await laterIterator.next()).toEqual({ done: true, value: undefined });
  });

  it('settles the owned waiter with a bounded source failure', async () => {
    const source = new PassThrough();
    const iterator = new BoundedProgressQueue(source)[Symbol.asyncIterator]();
    const pending = iterator.next();

    source.destroy(new Error('raw source detail'));

    await expect(pending).rejects.toMatchObject({
      code: 'PROGRESS_SOURCE_FAILED',
      message: 'Managed process progress stream failed',
    });
  });
});
