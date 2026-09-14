import { expect, it } from 'vitest';
import type {
  ManagedProcessPort,
  ProcessDiagnostics,
} from '../src/index.js';
import { bounded, cleanupManagedChild } from './managed-process-fixture.js';

const diagnostics: ProcessDiagnostics = {
  stdoutBytes: 0,
  stderrBytes: 0,
  warningChunks: 0,
  errorChunks: 0,
  streamErrors: 0,
  progressQueuedBytes: 0,
  progressQueuedItems: 0,
  progressDroppedBytes: 0,
  progressDroppedItems: 0,
  progressCoalescedItems: 0,
  fd4DrainListeners: 0,
  fd4ErrorListeners: 0,
  fd4CloseListeners: 0,
};

it('bounds fixture cleanup and releases handles when SIGKILL delivery fails', async () => {
  let released = false;
  const child = {
    close: new Promise<never>(() => undefined),
    progress: null,
    diagnostics: () => diagnostics,
    pumpFd4: async () => undefined,
    signal: () => ({ state: 'failed' } as const),
    status: () => ({ state: 'running' } as const),
    releaseHandles: () => { released = true; },
  } satisfies ManagedProcessPort & { readonly releaseHandles: () => void };

  const result = await bounded(cleanupManagedChild(child));

  expect(result).toEqual({ state: 'settled', value: undefined });
  expect(released).toBe(true);
});
