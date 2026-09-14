import { describe, expect, it } from 'vitest';
import {
  ProcessAdapterError,
  type ManagedProcessPort,
} from '../src/index.js';
import { nodePlan, withManagedChild } from './managed-process-fixture.js';

async function errorCode(promise: Promise<void>): Promise<string> {
  try {
    await promise;
    return 'FULFILLED';
  } catch (error) {
    if (error instanceof ProcessAdapterError) return error.code;
    throw error;
  }
}

async function awaitReady(child: ManagedProcessPort): Promise<void> {
  const progress = child.progress;
  if (progress === null) throw new TypeError('Expected fd3 progress');
  for await (const chunk of progress) {
    if (new TextDecoder().decode(chunk) === 'ready') return;
  }
  throw new TypeError('Child closed before readiness');
}

async function* backpressuredChunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(1_048_576);
  yield new Uint8Array(1_048_576);
}

type ListenerSnapshot = {
  readonly fd4DrainListeners: number;
  readonly fd4ErrorListeners: number;
  readonly fd4CloseListeners: number;
};

function listenerSnapshot(child: ManagedProcessPort): ListenerSnapshot {
  const current = child.diagnostics();
  return {
    fd4DrainListeners: current.fd4DrainListeners,
    fd4ErrorListeners: current.fd4ErrorListeners,
    fd4CloseListeners: current.fd4CloseListeners,
  };
}

describe('managed fd4 listener ownership', () => {
  it('removes drain, error, and close listeners after backpressured abort', async () => {
    const script = [
      "const fs=require('node:fs')",
      "fs.createReadStream(null,{fd:4}).pause()",
      "fs.writeSync(3,'ready')",
      "setInterval(()=>undefined,1000)",
    ].join(';');
    await withManagedChild(nodePlan(script), async (child) => {
      await awaitReady(child);
      const baseline = listenerSnapshot(child);
      const controller = new AbortController();
      const pumping = child.pumpFd4(backpressuredChunks(), controller.signal);
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();

      expect(await errorCode(pumping)).toBe('ABORTED');
      expect(listenerSnapshot(child)).toEqual(baseline);
    });
  });

  it('removes drain, error, and close listeners after child close', async () => {
    const script = [
      "const fs=require('node:fs')",
      "fs.createReadStream(null,{fd:4}).pause()",
      "fs.writeSync(3,'ready')",
      "process.on('SIGTERM',()=>process.exit(0))",
      "setInterval(()=>undefined,1000)",
    ].join(';');
    await withManagedChild(nodePlan(script), async (child) => {
      await awaitReady(child);
      const baseline = listenerSnapshot(child);
      const pumping = child.pumpFd4(backpressuredChunks(), new AbortController().signal);
      await Promise.resolve();
      expect(child.signal('SIGTERM')).toEqual({ state: 'delivered' });

      expect(['FD4_CLOSED', 'INPUT_FAILED']).toContain(await errorCode(pumping));
      expect(listenerSnapshot(child)).toEqual(baseline);
    });
  });

  it('removes drain, error, and close listeners after stream error', async () => {
    const script = [
      "const fs=require('node:fs')",
      "fs.createReadStream(null,{fd:4}).pause()",
      "fs.writeSync(3,'ready')",
      "process.on('SIGTERM',()=>fs.closeSync(4))",
      "setInterval(()=>undefined,1000)",
    ].join(';');
    await withManagedChild(nodePlan(script), async (child) => {
      await awaitReady(child);
      const baseline = listenerSnapshot(child);
      const pumping = child.pumpFd4(backpressuredChunks(), new AbortController().signal);
      await Promise.resolve();
      expect(child.signal('SIGTERM')).toEqual({ state: 'delivered' });

      expect(await errorCode(pumping)).toBe('INPUT_FAILED');
      expect(listenerSnapshot(child)).toEqual(baseline);
    });
  });
});
