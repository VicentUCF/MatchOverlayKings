class FakePipelineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FakePipelineError';
  }
}

export type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

export function deferred(): Deferred {
  let release: () => void = () => {
    throw new FakePipelineError('Deferred resolved before initialization');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

export class ActivePipelineTracker {
  private activePipelines = 0;
  private peakPipelines = 0;

  public get active(): number {
    return this.activePipelines;
  }

  public get peak(): number {
    return this.peakPipelines;
  }

  public activate(): void {
    this.activePipelines += 1;
    this.peakPipelines = Math.max(this.peakPipelines, this.activePipelines);
  }

  public deactivate(): void {
    if (this.activePipelines === 0) throw new FakePipelineError('No active pipeline to stop');
    this.activePipelines -= 1;
  }
}

export { FakePipelineError };
