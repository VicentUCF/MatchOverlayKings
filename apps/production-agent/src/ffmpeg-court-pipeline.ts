import type { OutputId } from '@kpl/production-contracts';
import { startFfmpegBackground } from './ffmpeg-court-background.js';
import { finalizeFfmpegGeneration, FfmpegFinalizationError } from './ffmpeg-court-finalization.js';
import {
  createFfmpegCourtGeneration,
  recordGenerationFault,
  targetsMatch,
  type FfmpegCourtGeneration,
  type GenerationFault,
} from './ffmpeg-court-generation.js';
import {
  FFMPEG_MONITOR_INTERVAL_MS,
  inspectFfmpegPreflight,
} from './ffmpeg-court-monitor.js';
import {
  FfmpegCourtPipelineError,
  type FfmpegCourtPipelineLifecycle,
  type FfmpegCourtPipelineOptions,
} from './ffmpeg-court-pipeline-model.js';
import { resolveFfmpegCourtPlan } from './ffmpeg-court-plan.js';
import {
  FfmpegCourtStartupDeadline,
  mapFfmpegStartError,
  unwrapSpawn,
} from './ffmpeg-court-startup.js';
import { projectFfmpegCourtRuntime } from './ffmpeg-court-runtime.js';
import type { ManagedProcessPort } from './managed-process.js';
import { PipelineRuntimeSchema, type PipelineRuntime, type PipelineTarget } from './models.js';
import type { CourtPipelinePort } from './ports.js';

export class FfmpegCourtPipeline implements CourtPipelinePort {
  readonly #options: FfmpegCourtPipelineOptions;
  readonly #runtimeOwners = new WeakMap<PipelineRuntime, FfmpegCourtGeneration>();
  #state: FfmpegCourtPipelineLifecycle = 'idle'; #current: FfmpegCourtGeneration | null = null;
  #startOperation: Promise<PipelineRuntime> | null = null; #stopOperation: Promise<void> | null = null;

  public constructor(options: FfmpegCourtPipelineOptions) { this.#options = options; }

  public readonly getRuntime = (outputId: OutputId, signal: AbortSignal): Promise<PipelineRuntime | null> => {
    void outputId;
    return projectFfmpegCourtRuntime(this.#state, this.#current, signal);
  };

  public readonly start = (target: PipelineTarget, signal: AbortSignal): Promise<PipelineRuntime> => {
    switch (this.#state) {
      case 'idle': return this.beginStart(target, signal);
      case 'starting': {
        const current = this.requireCurrent();
        if (targetsMatch(current.target, target) && this.#startOperation !== null) return this.#startOperation;
        return Promise.reject(new FfmpegCourtPipelineError('START_BLOCKED'));
      }
      case 'running':
      case 'stopping': return Promise.reject(new FfmpegCourtPipelineError('START_BLOCKED'));
      case 'cleanupPending': return Promise.reject(new FfmpegCourtPipelineError('CLEANUP_PENDING'));
      default: return assertNever(this.#state);
    }
  };

  public readonly stop = (runtime: PipelineRuntime, signal: AbortSignal): Promise<void> => {
    if (this.#state === 'idle') return Promise.resolve();
    const generation = this.requireCurrent();
    if (this.#runtimeOwners.get(runtime) !== generation) {
      return Promise.reject(new FfmpegCourtPipelineError('RUNTIME_MISMATCH'));
    }
    if (this.#state === 'starting') return Promise.reject(new FfmpegCourtPipelineError('RUNTIME_MISMATCH'));
    if (this.#state === 'stopping' && this.#stopOperation !== null) {
      finalizeFfmpegGeneration(generation, this.#options, signal);
      return this.#stopOperation;
    }
    generation.intentional = true;
    this.#state = 'stopping';
    return this.ownStop(this.finishGeneration(generation, signal));
  };

  private beginStart(target: PipelineTarget, signal: AbortSignal): Promise<PipelineRuntime> {
    const runtime = PipelineRuntimeSchema.parse({
      outputId: target.output.id,
      appliedDesiredVersion: target.desired.version,
      profileFingerprint: target.profileFingerprint,
    });
    const generation = createFfmpegCourtGeneration(target, runtime, this.#options.config.healthTimeoutMs);
    this.#runtimeOwners.set(runtime, generation);
    this.#current = generation;
    this.#state = 'starting';
    const startup = new FfmpegCourtStartupDeadline({
      controller: generation.startupController,
      externalSignal: signal,
      scheduler: this.#options.scheduler,
      timeoutMs: this.#options.config.startupTimeoutMs,
    });
    const operation = this.startGeneration(generation, startup);
    this.#startOperation = operation;
    void operation.then(() => this.clearStart(operation), () => this.clearStart(operation));
    return operation;
  }

  private async startGeneration(
    generation: FfmpegCourtGeneration,
    startup: FfmpegCourtStartupDeadline,
  ): Promise<PipelineRuntime> {
    try {
      generation.plan = resolveFfmpegCourtPlan(this.#options, generation.target);
      startup.throwIfTerminated();
      await startup.waitFor(inspectFfmpegPreflight(generation, this.#options));
      const spawned = this.#options.spawner.spawn(generation.plan.command);
      const spawnResult = await startup.race(spawned);
      if (spawnResult.kind === 'terminated') {
        this.ownLateSpawn(generation, spawned);
        throw new FfmpegCourtPipelineError(spawnResult.code);
      }
      generation.process = unwrapSpawn(spawnResult);
      this.startBackgroundWork(generation);
      startup.throwIfTerminated();
      await startup.awaitReadiness(generation);
      return this.publishRuntime(generation, startup);
    } catch (error) {
      const code = startup.code ?? mapFfmpegStartError(error, generation);
      generation.intentional = true;
      if (generation.lateSpawnPending) throw new FfmpegCourtPipelineError(code);
      try {
        await this.finishGeneration(generation, new AbortController().signal);
      } catch (cleanupError) {
        if (cleanupError instanceof FfmpegCourtPipelineError) throw cleanupError;
        throw new FfmpegCourtPipelineError('CLEANUP_PENDING');
      }
      throw new FfmpegCourtPipelineError(code);
    } finally {
      startup.dispose();
    }
  }

  private startBackgroundWork(generation: FfmpegCourtGeneration): void {
    startFfmpegBackground(generation, this.#options, {
      changed: () => { this.tryResolveReady(generation); },
      failed: (fault) => { this.handleFault(generation, fault); },
      closed: () => { this.handleProcessClose(generation); },
    });
  }

  private tryResolveReady(generation: FfmpegCourtGeneration): void {
    if (this.#current === generation && this.#state === 'starting'
      && generation.fault === null && !generation.intentional
      && !generation.startupController.signal.aborted
      && generation.progressReady && generation.mediaReady
      && generation.process?.status().state === 'running') generation.resolveReady();
  }

  private handleFault(generation: FfmpegCourtGeneration, fault: GenerationFault): void {
    if (!recordGenerationFault(generation, fault) || this.#current !== generation) return;
    const startupActive = this.#state === 'starting';
    this.#state = 'stopping';
    if (startupActive) return;
    const operation = this.finishGeneration(generation, new AbortController().signal);
    this.ownStop(operation);
    this.handleSettlement(operation);
  }

  private handleProcessClose(generation: FfmpegCourtGeneration): void {
    if (this.#current !== generation) return;
    if (!generation.intentional) {
      const status = generation.process?.status();
      if (status?.state !== 'closed' || status.close.code !== 0 || status.close.signal !== null) {
        this.handleFault(generation, 'PROCESS_FAILED');
      }
      return;
    }
    if (this.#state !== 'cleanupPending') return;
    const operation = this.finishGeneration(generation, new AbortController().signal);
    this.ownStop(operation);
    this.handleSettlement(operation);
  }

  private finishGeneration(generation: FfmpegCourtGeneration, signal: AbortSignal): Promise<void> {
    const finalization = finalizeFfmpegGeneration(generation, this.#options, signal);
    return finalization.then(
      () => { this.completeGeneration(generation); },
      (error: unknown) => {
        if (this.#current === generation) {
          this.#state = 'cleanupPending';
          this.scheduleCleanupRecovery(generation);
        }
        if (error instanceof FfmpegFinalizationError) throw new FfmpegCourtPipelineError('STOP_FAILED');
        throw new FfmpegCourtPipelineError('CLEANUP_PENDING');
      },
    );
  }

  private ownStop(operation: Promise<void>): Promise<void> {
    this.#stopOperation = operation;
    void operation.then(() => this.clearStop(operation), () => this.clearStop(operation));
    return operation;
  }

  private completeGeneration(generation: FfmpegCourtGeneration): void {
    if (this.#current !== generation) return;
    this.#current = null; this.#state = 'idle';
  }

  private publishRuntime(
    generation: FfmpegCourtGeneration,
    startup: FfmpegCourtStartupDeadline,
  ): PipelineRuntime {
    startup.throwIfTerminated();
    if (this.#current !== generation || this.#state !== 'starting'
      || generation.fault !== null || generation.intentional
      || generation.process?.status().state !== 'running') {
      throw new FfmpegCourtPipelineError(generation.fault ?? 'PROCESS_FAILED');
    }
    this.#state = 'running';
    return generation.runtime;
  }

  private ownLateSpawn(
    generation: FfmpegCourtGeneration,
    spawned: Promise<ManagedProcessPort>,
  ): void {
    generation.lateSpawnPending = true;
    generation.intentional = true;
    if (this.#current === generation) this.#state = 'cleanupPending';
    const operation = spawned.then(
      (process) => {
        generation.lateSpawnPending = false;
        generation.process = process;
        if (this.#current === generation) this.#state = 'stopping';
        this.startBackgroundWork(generation);
        return this.finishGeneration(generation, new AbortController().signal);
      },
      () => {
        generation.lateSpawnPending = false;
        this.completeGeneration(generation);
      },
    );
    this.ownStop(operation);
    this.handleSettlement(operation);
  }

  private scheduleCleanupRecovery(generation: FfmpegCourtGeneration): void {
    if (generation.recoveryOperation !== null || this.#current !== generation) return;
    const operation = this.recoverCleanup(generation);
    generation.recoveryOperation = operation;
    void operation.then(
      () => { if (generation.recoveryOperation === operation) generation.recoveryOperation = null; },
      () => { if (generation.recoveryOperation === operation) generation.recoveryOperation = null; },
    );
  }

  private async recoverCleanup(generation: FfmpegCourtGeneration): Promise<void> {
    while (this.#current === generation && this.#state === 'cleanupPending') {
      await this.#options.scheduler.wait(FFMPEG_MONITOR_INTERVAL_MS, new AbortController().signal);
      if (this.#current !== generation || this.#state !== 'cleanupPending') return;
      try {
        await this.finishGeneration(generation, new AbortController().signal);
      } catch (error) {
        if (!(error instanceof FfmpegCourtPipelineError)) throw error;
      }
    }
  }

  private handleSettlement(operation: Promise<void>): void {
    void operation.then(() => undefined, () => undefined);
  }

  private clearStart(operation: Promise<PipelineRuntime>): void { if (this.#startOperation === operation) this.#startOperation = null; }

  private clearStop(operation: Promise<void>): void { if (this.#stopOperation === operation) this.#stopOperation = null; }

  private requireCurrent(): FfmpegCourtGeneration {
    if (this.#current === null) throw new FfmpegCourtPipelineError('CLEANUP_PENDING'); return this.#current;
  }
}

function assertNever(value: never): never { throw new TypeError(`Unexpected state: ${value}`); }
