import { describe, expect, it } from 'vitest';
import { ProcessAdapterError } from '../src/index.js';
import { bounded, nodePlan, withManagedChild } from './managed-process-fixture.js';

type SourceState = { returned: boolean };

function pendingSource(state: SourceState): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: () => new Promise(() => undefined),
        return: () => {
          state.returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

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

describe('managed fd4 input', () => {
  it('settles a pre-aborted pump without waiting for its producer', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const state = { returned: false };
      const controller = new AbortController();
      controller.abort();

      const outcome = await bounded(errorCode(child.pumpFd4(pendingSource(state), controller.signal)));

      expect(outcome).toEqual({ state: 'settled', value: 'ABORTED' });
      expect(state.returned).toBe(true);
    });
  });

  it('settles abort while iterator.next is pending and calls iterator.return', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const state = { returned: false };
      const controller = new AbortController();
      const pumping = child.pumpFd4(pendingSource(state), controller.signal);
      controller.abort();

      const outcome = await bounded(errorCode(pumping));

      expect(outcome).toEqual({ state: 'settled', value: 'ABORTED' });
      expect(state.returned).toBe(true);
    });
  });

  it('rejects a second owner while the first pump is active', async () => {
    await withManagedChild(nodePlan(readerScript), async (child) => {
      const controller = new AbortController();
      const first = child.pumpFd4(pendingSource({ returned: false }), controller.signal);

      const second = await bounded(errorCode(child.pumpFd4(pendingSource({ returned: false }), controller.signal)));
      controller.abort();
      const firstResult = await bounded(errorCode(first));

      expect(second).toEqual({ state: 'settled', value: 'FD4_ALREADY_OWNED' });
      expect(firstResult).toEqual({ state: 'settled', value: 'ABORTED' });
    });
  });

  it('settles when the child closes while iterator.next is pending', async () => {
    await withManagedChild(nodePlan('', ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']), async (child) => {
      const state = { returned: false };

      const outcome = await bounded(errorCode(
        child.pumpFd4(pendingSource(state), new AbortController().signal),
      ));

      expect(outcome).toEqual({ state: 'settled', value: 'FD4_CLOSED' });
      expect(state.returned).toBe(true);
    });
  });

  it('normalizes fd4 errors without exposing raw stream messages', async () => {
    const script = "const fs=require('node:fs');fs.closeSync(4);setInterval(()=>undefined,1000)";
    await withManagedChild(nodePlan(script), async (child) => {
      async function* chunks(): AsyncGenerator<Uint8Array> {
        yield new Uint8Array(1_048_576);
      }

      const code = await errorCode(child.pumpFd4(chunks(), new AbortController().signal));

      expect(code).toBe('INPUT_FAILED');
    });
  });

  it('does not pull another chunk before fd4 drains', async () => {
    const script = [
      "const fs=require('node:fs')",
      "let bytes=0",
      "const input=fs.createReadStream(null,{fd:4})",
      "input.on('data',chunk=>{bytes+=chunk.length})",
      "input.on('end',()=>process.exit(bytes===2097152?0:23))",
      "input.pause()",
      "process.on('SIGTERM',()=>input.resume())",
      "fs.writeSync(3,'ready')",
    ].join(';');
    await withManagedChild(nodePlan(script), async (child) => {
      const progress = child.progress;
      if (progress === null) throw new TypeError('Expected fd3 progress');
      let ready = '';
      for await (const chunk of progress) {
        ready += new TextDecoder().decode(chunk);
        if (ready === 'ready') break;
      }
      let pulls = 0;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        pulls += 1;
        yield new Uint8Array(1_048_576);
        pulls += 1;
        yield new Uint8Array(1_048_576);
      }

      const pumping = child.pumpFd4(chunks(), new AbortController().signal);
      await Promise.resolve();
      await Promise.resolve();
      expect(pulls).toBe(1);
      expect(child.signal('SIGTERM')).toEqual({ state: 'delivered' });
      await pumping;
      expect(await child.close).toEqual({ code: 0, signal: null });
    });
  });
});
