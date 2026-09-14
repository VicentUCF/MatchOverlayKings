import { describe, expect, it } from 'vitest';
import { ProcessAdapterError } from '../src/index.js';
import { bounded, nodePlan, withManagedChild } from './managed-process-fixture.js';

async function errorCode(promise: Promise<void>): Promise<string> {
  try {
    await promise;
    return 'FULFILLED';
  } catch (error) {
    if (error instanceof ProcessAdapterError) return error.code;
    throw error;
  }
}

const readerScript = [
  "const fs=require('node:fs')",
  "const input=fs.createReadStream(null,{fd:4})",
  "input.resume()",
  "input.on('end',()=>process.exit(0))",
].join(';');

describe('managed fd4 boundary failures', () => {
  it('settles abort without awaiting a blocked standard async generator return', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      let notifyStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
      async function* blocked(): AsyncGenerator<Uint8Array> {
        notifyStarted();
        await new Promise(() => undefined);
        yield new Uint8Array([1]);
      }
      const controller = new AbortController();
      const pumping = child.pumpFd4(blocked(), controller.signal);
      await started;
      controller.abort();

      expect(await bounded(errorCode(pumping))).toEqual({ state: 'settled', value: 'ABORTED' });
      expect(await bounded(errorCode(child.pumpFd4(blocked(), controller.signal))))
        .toEqual({ state: 'settled', value: 'FD4_CLOSED' });
    });
  });

  it('settles child close without awaiting a blocked standard async generator return', async () => {
    const script = [
      "const fs=require('node:fs')",
      "fs.writeSync(3,'ready')",
      "process.on('SIGTERM',()=>process.exit(0))",
      "setInterval(()=>undefined,1000)",
    ].join(';');
    await withManagedChild(nodePlan(script), async (child) => {
      const progress = child.progress;
      if (progress === null) throw new TypeError('Expected fd3 progress');
      for await (const chunk of progress) {
        if (new TextDecoder().decode(chunk) === 'ready') break;
      }
      let notifyStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
      async function* blocked(): AsyncGenerator<Uint8Array> {
        notifyStarted();
        await new Promise(() => undefined);
        yield new Uint8Array([1]);
      }
      const pumping = child.pumpFd4(blocked(), new AbortController().signal);
      await started;
      expect(child.signal('SIGTERM')).toEqual({ state: 'delivered' });

      expect(await bounded(errorCode(pumping))).toEqual({ state: 'settled', value: 'FD4_CLOSED' });
    });
  });

  it('preserves abort when retrieving iterator return throws', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const controller = new AbortController();
      const hostile: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => new Promise(() => undefined),
            get return(): (value?: unknown) => Promise<IteratorResult<Uint8Array>> {
              throw Object.freeze({ detail: 'raw return getter' });
            },
          };
        },
      };
      const pumping = child.pumpFd4(hostile, controller.signal);
      controller.abort();

      expect(await bounded(errorCode(pumping))).toEqual({ state: 'settled', value: 'ABORTED' });
    });
  });

  it('consumes asynchronous cleanup rejection after preserving terminal error', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      let notifyRejected: () => void = () => undefined;
      const rejected = new Promise<void>((resolve) => { notifyRejected = resolve; });
      const controller = new AbortController();
      const hostile: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => new Promise(() => undefined),
            return: () => new Promise((_resolve, reject) => {
              queueMicrotask(() => {
                reject(Object.freeze({ detail: 'raw async return' }));
                notifyRejected();
              });
            }),
          };
        },
      };
      const pumping = child.pumpFd4(hostile, controller.signal);
      controller.abort();

      expect(await bounded(errorCode(pumping))).toEqual({ state: 'settled', value: 'ABORTED' });
      await rejected;
      await Promise.resolve();
    });
  });

  it('normalizes synchronous non-Error iterator acquisition and releases ownership', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const hostile: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          throw Object.freeze({ detail: 'raw acquisition' });
        },
      };

      expect(await errorCode(child.pumpFd4(hostile, new AbortController().signal))).toBe('INPUT_FAILED');
      expect(await errorCode(child.pumpFd4(hostile, new AbortController().signal))).not.toBe('FD4_ALREADY_OWNED');
    });
  });

  it('normalizes a non-Error producer rejection and invokes iterator cleanup', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      let returned = false;
      const hostile: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => Promise.reject(Object.freeze({ detail: 'raw next' })),
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          };
        },
      };

      expect(await errorCode(child.pumpFd4(hostile, new AbortController().signal))).toBe('INPUT_FAILED');
      expect(returned).toBe(true);
    });
  });

  it('reports cleanup rejection when cleanup is the sole failure', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const hostile: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: async () => ({ done: true, value: undefined }),
            return: () => Promise.reject(Object.freeze({ detail: 'raw return' })),
          };
        },
      };

      expect(await errorCode(child.pumpFd4(hostile, new AbortController().signal))).toBe('INPUT_FAILED');
    });
  });

  it('preserves abort when iterator cleanup also rejects', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const controller = new AbortController();
      controller.abort();
      const hostile: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => new Promise(() => undefined),
            return: () => Promise.reject(Object.freeze({ detail: 'raw return' })),
          };
        },
      };

      expect(await errorCode(child.pumpFd4(hostile, controller.signal))).toBe('ABORTED');
    });
  });

  it('rejects premature fd4 close instead of accepting truncated input', async () => {
    const script = [
      "const fs=require('node:fs')",
      "const input=fs.createReadStream(null,{fd:4})",
      "input.once('data',()=>input.destroy())",
      "setInterval(()=>undefined,1000)",
    ].join(';');
    await withManagedChild(nodePlan(script), async (child) => {
      async function* chunks(): AsyncGenerator<Uint8Array> {
        yield new Uint8Array(1_048_576);
        yield new Uint8Array(1_048_576);
      }

      expect(['FD4_CLOSED', 'INPUT_FAILED']).toContain(
        await errorCode(child.pumpFd4(chunks(), new AbortController().signal)),
      );
    });
  });
});
