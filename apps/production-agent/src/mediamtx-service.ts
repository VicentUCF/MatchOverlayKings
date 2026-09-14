import type { MediaMtxApiClientFactoryPort, MediaMtxPathsSnapshot, MediaMtxPathStatus } from './mediamtx-api-client.js';
import type { MediaMtxApiCredentialFactoryPort } from './mediamtx-api-credentials.js';
import type { EphemeralRuntimeFilesPort } from './ephemeral-runtime-files.js';
import { cleanupGenerationBeforeSpawn, createMediaMtxGeneration, finalizeGenerationAfterClose,
  inspectGenerationPaths, MediaMtxGenerationCleanupError, quiesceGenerationInspections,
  resetGenerationFinalization, trackGenerationApiOperation, type MediaMtxGeneration } from './mediamtx-generation.js';
import type { ProcessSpawnerPort } from './managed-process.js';
import type { LocalMediaRuntimeConfig } from './media-runtime-config.js';
import { buildMediaMtxCommand, buildMediaMtxConfigYaml } from './mediamtx-plan.js';
import { MediaMtxReadinessError, waitForMediaMtxReadiness } from './mediamtx-readiness.js';
import {
  MediaMtxServiceError,
  projectMediaMtxServiceStatus,
  type MediaMtxServiceState,
  type MediaMtxServiceStatus,
} from './mediamtx-service-model.js';
import { stopMediaMtxProcess } from './mediamtx-service-stop.js';
import type { SchedulerPort } from './process-stop.js';
export { MediaMtxServiceError, type MediaMtxServiceErrorCode,
  type MediaMtxServiceStatus } from './mediamtx-service-model.js';

export type MediaMtxServiceOptions = {
  readonly config: LocalMediaRuntimeConfig;
  readonly runtimeFiles: EphemeralRuntimeFilesPort;
  readonly spawner: ProcessSpawnerPort;
  readonly scheduler: SchedulerPort;
  readonly credentialFactory: MediaMtxApiCredentialFactoryPort;
  readonly apiClientFactory: MediaMtxApiClientFactoryPort;
};

export class MediaMtxService {
  readonly #options: MediaMtxServiceOptions;
  #state: MediaMtxServiceState = 'idle';
  #paths: readonly MediaMtxPathStatus[] = Object.freeze([]);
  #current: MediaMtxGeneration | null = null;
  #startOperation: Promise<void> | null = null;
  #stopOperation: Promise<void> | null = null;
  public constructor(options: MediaMtxServiceOptions) { this.#options = options; }

  public status(): MediaMtxServiceStatus {
    return projectMediaMtxServiceStatus(this.#state, this.#paths);
  }

  public start(): Promise<void> {
    switch (this.#state) {
      case 'starting': return this.#startOperation ?? Promise.reject(new MediaMtxServiceError('START_FAILED'));
      case 'running': return Promise.resolve();
      case 'stopping':
      case 'cleanupPending': return Promise.reject(new MediaMtxServiceError('START_BLOCKED'));
      case 'idle': return this.beginStart();
      default: return assertNever(this.#state);
    }
  }

  public async inspectPaths(signal: AbortSignal): Promise<MediaMtxPathsSnapshot> {
    if (this.#state !== 'running' || this.#current === null) {
      throw new MediaMtxServiceError('INSPECTION_BLOCKED');
    }
    const generation = this.#current;
    if (generation.process?.status().state !== 'running') {
      throw new MediaMtxServiceError('INSPECTION_BLOCKED');
    }
    const snapshot = await inspectGenerationPaths(generation, signal);
    if (this.#state === 'running' && this.#current === generation) this.#paths = snapshot.items;
    return snapshot;
  }

  public stop(): Promise<void> {
    switch (this.#state) {
      case 'idle': return Promise.resolve();
      case 'stopping': return this.#stopOperation ?? Promise.reject(new MediaMtxServiceError('CLEANUP_PENDING'));
      case 'starting': return this.stopStarting();
      case 'running':
      case 'cleanupPending': return this.stopCurrent();
      default: return assertNever(this.#state);
    }
  }

  private beginStart(): Promise<void> {
    const generation = createMediaMtxGeneration();
    this.#current = generation;
    this.#state = 'starting';
    const operation = this.startGeneration(generation);
    this.#startOperation = operation;
    void operation.then(
      () => { if (this.#startOperation === operation) this.#startOperation = null; },
      () => { if (this.#startOperation === operation) this.#startOperation = null; },
    );
    return operation;
  }

  private async startGeneration(generation: MediaMtxGeneration): Promise<void> {
    try {
      generation.credentials = this.#options.credentialFactory.create();
      const configYaml = buildMediaMtxConfigYaml(this.#options.config, generation.credentials.planner());
      if (generation.stopRequested) throw new MediaMtxReadinessError('ABORTED');
      generation.artifact = await this.#options.runtimeFiles.create({
        rootPath: this.#options.config.runtimeDirectoryPath,
        directoryMode: this.#options.config.runtimeDirectoryMode,
        fileMode: this.#options.config.configFileMode,
        configYaml,
      });
      if (generation.stopRequested) throw new MediaMtxReadinessError('ABORTED');
      generation.process = await this.#options.spawner.spawn(
        buildMediaMtxCommand(this.#options.config, generation.artifact.configPath),
      );
      this.watchClose(generation);
      generation.client = this.#options.apiClientFactory.create({
        host: this.#options.config.bindings.apiHost,
        port: this.#options.config.bindings.apiPort,
        credential: generation.credentials,
      });
      const readiness = waitForMediaMtxReadiness({
        client: generation.client,
        process: generation.process,
        scheduler: this.#options.scheduler,
        expectedPathNames: this.#options.config.bindings.courts.map(({ pathName }) => pathName),
        startupTimeoutMs: this.#options.config.startupTimeoutMs,
        probeController: generation.probeController,
      });
      const paths = await trackGenerationApiOperation(generation, readiness, generation.probeController);
      if (generation.stopRequested) throw new MediaMtxReadinessError('ABORTED');
      if (this.#current === generation) {
        this.#paths = paths.items;
        this.#state = 'running';
      }
    } catch (error) {
      await this.rollbackStart(generation, error);
    }
  }

  private async rollbackStart(generation: MediaMtxGeneration, failure: unknown): Promise<never> {
    const startCode = generation.stopRequested ? 'START_ABORTED' : 'START_FAILED';
    try {
      if (generation.process !== null) {
        await quiesceGenerationInspections(generation);
        if (generation.process.status().state === 'running') {
          await stopMediaMtxProcess(generation.process, this.#options.scheduler, this.#options.config.stopGraceMs);
        }
        await finalizeGenerationAfterClose(generation);
      } else {
        await cleanupGenerationBeforeSpawn(generation, failure);
      }
      this.finishGeneration(generation);
    } catch (error) {
      if (error instanceof MediaMtxGenerationCleanupError) throw this.enterCleanupPending(generation);
      throw this.enterCleanupPending(generation);
    }
    throw new MediaMtxServiceError(startCode);
  }

  private stopStarting(): Promise<void> {
    const generation = this.requireCurrent();
    const start = this.#startOperation;
    if (start === null) return Promise.reject(new MediaMtxServiceError('CLEANUP_PENDING'));
    generation.stopRequested = true;
    generation.probeController.abort();
    this.#state = 'stopping';
    const operation = this.awaitStoppedStart(start);
    return this.ownStop(operation);
  }

  private async awaitStoppedStart(start: Promise<void>): Promise<void> {
    try {
      await start;
    } catch (error) {
      if (!(error instanceof MediaMtxServiceError)) throw error;
      if (error.code === 'CLEANUP_PENDING') throw error;
    }
  }

  private stopCurrent(): Promise<void> {
    const generation = this.requireCurrent();
    if (this.#state === 'cleanupPending') resetGenerationFinalization(generation);
    generation.stopRequested = true;
    generation.probeController.abort();
    this.#state = 'stopping';
    const operation = this.teardownCurrent(generation);
    return this.ownStop(operation);
  }

  private async teardownCurrent(generation: MediaMtxGeneration): Promise<void> {
    try {
      await quiesceGenerationInspections(generation);
      if (generation.process !== null) {
        if (generation.process.status().state === 'running') {
          await stopMediaMtxProcess(generation.process, this.#options.scheduler, this.#options.config.stopGraceMs);
        }
        await finalizeGenerationAfterClose(generation);
      } else {
        await cleanupGenerationBeforeSpawn(generation, new MediaMtxGenerationCleanupError());
      }
      this.finishGeneration(generation);
    } catch (error) {
      if (error instanceof MediaMtxGenerationCleanupError) throw this.enterCleanupPending(generation);
      throw this.enterCleanupPending(generation);
    }
  }

  private ownStop(operation: Promise<void>): Promise<void> {
    this.#stopOperation = operation;
    void operation.then(
      () => this.clearOwnedStop(operation),
      () => this.clearOwnedStop(operation),
    );
    return operation;
  }

  private clearOwnedStop(operation: Promise<void>): void {
    if (this.#stopOperation === operation) this.#stopOperation = null;
  }

  private watchClose(generation: MediaMtxGeneration): void {
    const process = generation.process;
    if (process === null) return;
    void process.close.then(
      () => finalizeGenerationAfterClose(generation)
        .then(() => this.finishGeneration(generation))
        .catch((error: unknown) => {
          if (error instanceof MediaMtxGenerationCleanupError) {
            this.enterCleanupPending(generation);
            return;
          }
          this.enterCleanupPending(generation);
        }),
      () => { this.enterCleanupPending(generation); },
    );
  }

  private enterCleanupPending(generation: MediaMtxGeneration): MediaMtxServiceError {
    if (this.#current === generation) this.#state = 'cleanupPending';
    return new MediaMtxServiceError('CLEANUP_PENDING');
  }

  private finishGeneration(generation: MediaMtxGeneration): void {
    if (this.#current !== generation) return;
    this.#current = null;
    this.#paths = Object.freeze([]);
    this.#state = 'idle';
  }

  private requireCurrent(): MediaMtxGeneration {
    if (this.#current === null) throw new MediaMtxServiceError('CLEANUP_PENDING');
    return this.#current;
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected MediaMTX service state: ${String(value)}`);
}
