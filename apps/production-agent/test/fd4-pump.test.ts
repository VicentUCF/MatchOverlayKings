import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pumpFd4Input } from '../src/fd4-pump.js';
import { deferred, expectPending } from './ffmpeg-court-pipeline-fixture.js';

function pendingChunks(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return { next: () => new Promise(() => undefined) };
    },
  };
}

describe('fd4 pump child lifecycle', () => {
  it('settles a rejected child close without an unhandled rejection', async () => {
    // Given
    const childClose = deferred<void>();
    const controller = new AbortController();
    const pumping = pumpFd4Input({
      input: new PassThrough(),
      chunks: pendingChunks(),
      signal: controller.signal,
      childClose: childClose.promise,
    });
    await expectPending(pumping);

    // When
    childClose.reject(new Error('synthetic close rejection'));
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    // Then
    await expect(pumping).rejects.toMatchObject({ code: 'FD4_CLOSED' });
  });
});
