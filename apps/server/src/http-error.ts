import type { CommandError, CommandErrorCode, MatchState } from '@kpl/shared';

export class HttpCommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly statusCode: number,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}

export function commandError(
  code: CommandErrorCode,
  message: string,
  current?: MatchState,
): CommandError {
  return {
    code,
    message,
    ...(current ? { currentVersion: current.version } : {}),
  };
}
