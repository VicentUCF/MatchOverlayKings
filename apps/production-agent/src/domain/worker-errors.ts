export class CourtConfigurationMismatchError extends Error {
  public constructor() {
    super('Snapshot court does not match worker court');
    this.name = 'CourtConfigurationMismatchError';
  }
}

export class UnexpectedWorkerActionError extends Error {
  public constructor() {
    super('Unexpected worker action');
    this.name = 'UnexpectedWorkerActionError';
  }
}

export class RuntimeOutputMismatchError extends Error {
  public constructor() {
    super('Inspected runtime does not match requested output');
    this.name = 'RuntimeOutputMismatchError';
  }
}
