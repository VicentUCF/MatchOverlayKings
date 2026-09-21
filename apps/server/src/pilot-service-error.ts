export type PilotServiceErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NOT_READY'
  | 'RUNTIME_ERROR'
  | 'FORBIDDEN';

export class PilotServiceError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: PilotServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PilotServiceError';
  }
}
