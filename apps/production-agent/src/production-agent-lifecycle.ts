import type { AgentLogger } from './agent-logger.js';
import type { SupervisorShutdownResult } from './orchestration-models.js';
import type { SchedulerPort } from './process-stop.js';

export type ProductionSignal = 'SIGINT' | 'SIGTERM';

export interface ProductionSignalSource {
  readonly subscribe: (listener: (signal: ProductionSignal) => void) => () => void;
}

export interface ProductionAgentLoopPort {
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export type ProductionAgentLifecycleOptions = {
  readonly mediaService: {
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<void>;
  };
  readonly supervisor: {
    readonly shutdown: () => Promise<SupervisorShutdownResult>;
  };
  readonly loop: ProductionAgentLoopPort;
  readonly scheduler: SchedulerPort;
  readonly signals: ProductionSignalSource;
  readonly logger: AgentLogger;
  readonly shutdownDeadlineMs: number;
  readonly hardExit: (code: 1) => void;
};

export class ProductionAgentShutdownDeadlineError extends Error {
  public readonly code = 'SHUTDOWN_DEADLINE' as const;

  public constructor() {
    super('Production agent shutdown deadline elapsed');
    this.name = 'ProductionAgentShutdownDeadlineError';
  }
}

export class NodeProductionSignalSource implements ProductionSignalSource {
  public subscribe(listener: (signal: ProductionSignal) => void): () => void {
    const onInterrupt = (): void => { listener('SIGINT'); };
    const onTerminate = (): void => { listener('SIGTERM'); };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    return () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
  }
}

type Settlement =
  | { readonly kind: 'fulfilled' }
  | { readonly kind: 'rejected'; readonly reason: unknown };

export class ProductionAgentLifecycle {
  private readonly controller = new AbortController();
  private shutdownOperation: Promise<void> | null = null;

  public constructor(private readonly options: ProductionAgentLifecycleOptions) {}

  public async run(): Promise<void> {
    const unsubscribe = this.options.signals.subscribe(() => {
      void this.shutdown().then(() => undefined, () => undefined);
    });
    try {
      await this.options.mediaService.start();
      this.options.logger.log('info', 'agent_started');
      if (!this.controller.signal.aborted) await this.options.loop.run(this.controller.signal);
      await this.shutdown();
    } catch (error) {
      const shutdownRequested = this.controller.signal.aborted;
      this.controller.abort();
      await this.shutdown();
      if (shutdownRequested) return;
      throw error;
    } finally {
      unsubscribe();
    }
  }

  public shutdown(): Promise<void> {
    const active = this.shutdownOperation;
    if (active !== null) return active;
    this.controller.abort();
    const operation = this.shutdownWithinDeadline();
    this.shutdownOperation = operation;
    return operation;
  }

  private async shutdownWithinDeadline(): Promise<void> {
    const deadlineController = new AbortController();
    const cleanup = this.cleanup();
    try {
      const deadlineElapsed = await Promise.race([
        cleanup.then(() => false),
        this.options.scheduler
          .wait(this.options.shutdownDeadlineMs, deadlineController.signal)
          .then(() => true),
      ]);
      if (deadlineElapsed && !deadlineController.signal.aborted) {
        this.options.hardExit(1);
        throw new ProductionAgentShutdownDeadlineError();
      }
    } finally {
      deadlineController.abort();
    }
  }

  private async cleanup(): Promise<void> {
    const supervisor = await settle(this.options.supervisor.shutdown());
    const media = await settle(this.options.mediaService.stop());
    if (supervisor.kind === 'rejected') throw supervisor.reason;
    if (media.kind === 'rejected') throw media.reason;
    this.options.logger.log('info', 'agent_stopped');
  }
}

function settle(operation: Promise<unknown>): Promise<Settlement> {
  return operation.then(
    (): Settlement => ({ kind: 'fulfilled' }),
    (reason: unknown): Settlement => ({ kind: 'rejected', reason }),
  );
}
