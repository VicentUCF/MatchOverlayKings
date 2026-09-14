import type { MediaMtxApiClientPort, MediaMtxPathsSnapshot } from './mediamtx-api-client.js';
import type { MediaMtxApiCredentials } from './mediamtx-api-credentials.js';
import {
  isEphemeralRuntimeCleanupRecovery,
  type EphemeralRuntimeArtifact,
  type EphemeralRuntimeCleanupRecovery,
} from './ephemeral-runtime-files.js';
import type { ManagedProcessPort } from './managed-process.js';

export type MediaMtxGeneration = {
  credentials: MediaMtxApiCredentials | null;
  client: MediaMtxApiClientPort | null;
  artifact: EphemeralRuntimeArtifact | null;
  process: ManagedProcessPort | null;
  recovery: EphemeralRuntimeCleanupRecovery | null;
  readonly probeController: AbortController;
  stopRequested: boolean;
  disposed: boolean;
  released: boolean;
  finalization: Promise<void> | null;
  readonly inspections: Map<Promise<void>, AbortController>;
};

export class MediaMtxGenerationCleanupError extends Error {
  public readonly code = 'CLEANUP_FAILED' as const;

  public constructor() {
    super('MediaMTX generation cleanup failed');
    this.name = 'MediaMtxGenerationCleanupError';
  }
}

export function createMediaMtxGeneration(): MediaMtxGeneration {
  return {
    credentials: null,
    client: null,
    artifact: null,
    process: null,
    recovery: null,
    probeController: new AbortController(),
    stopRequested: false,
    disposed: false,
    released: false,
    finalization: null,
    inspections: new Map(),
  };
}

export function disposeGenerationCredentials(generation: MediaMtxGeneration): void {
  if (generation.disposed || generation.credentials === null) return;
  generation.disposed = true;
  generation.credentials.dispose();
}

export async function inspectGenerationPaths(
  generation: MediaMtxGeneration,
  signal: AbortSignal,
): Promise<MediaMtxPathsSnapshot> {
  if (generation.client === null) throw new TypeError('MediaMTX generation has no API client');
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const operation = generation.client.listPaths(controller.signal);
  try {
    return await trackGenerationApiOperation(generation, operation, controller);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function trackGenerationApiOperation<Result>(
  generation: MediaMtxGeneration,
  operation: Promise<Result>,
  controller: AbortController,
): Promise<Result> {
  const settlement = operation.then(() => undefined, () => undefined);
  generation.inspections.set(settlement, controller);
  try {
    return await operation;
  } finally {
    generation.inspections.delete(settlement);
  }
}

export async function quiesceGenerationInspections(generation: MediaMtxGeneration): Promise<void> {
  const operations = [...generation.inspections.keys()];
  for (const controller of generation.inspections.values()) controller.abort();
  await Promise.all(operations);
}

export async function cleanupGenerationBeforeSpawn(
  generation: MediaMtxGeneration,
  failure: unknown,
): Promise<void> {
  disposeGenerationCredentials(generation);
  if (isEphemeralRuntimeCleanupRecovery(failure)) {
    generation.recovery = failure;
    throw new MediaMtxGenerationCleanupError();
  }
  await cleanupGenerationArtifact(generation);
}

export function resetGenerationFinalization(generation: MediaMtxGeneration): void {
  generation.finalization = null;
}

export function finalizeGenerationAfterClose(generation: MediaMtxGeneration): Promise<void> {
  if (generation.finalization !== null) return generation.finalization;
  const operation = performFinalization(generation);
  generation.finalization = operation;
  return operation;
}

async function performFinalization(generation: MediaMtxGeneration): Promise<void> {
  const process = generation.process;
  if (process === null) throw new MediaMtxGenerationCleanupError();
  try {
    await process.close;
    await quiesceGenerationInspections(generation);
    if (!generation.released) {
      generation.released = true;
      process.releaseHandles();
    }
    disposeGenerationCredentials(generation);
    await cleanupGenerationArtifact(generation);
  } catch (error) {
    if (error instanceof MediaMtxGenerationCleanupError) throw error;
    throw new MediaMtxGenerationCleanupError();
  }
}

async function cleanupGenerationArtifact(generation: MediaMtxGeneration): Promise<void> {
  try {
    if (generation.recovery !== null) {
      await generation.recovery.retryCleanup();
      generation.recovery = null;
      return;
    }
    if (generation.artifact === null) return;
    await generation.artifact.cleanup();
    generation.artifact = null;
  } catch (error) {
    if (isEphemeralRuntimeCleanupRecovery(error)) {
      generation.recovery = error;
      generation.artifact = null;
    }
    throw new MediaMtxGenerationCleanupError();
  }
}
