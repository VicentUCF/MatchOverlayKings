import type { MediaMtxPathStatus } from './mediamtx-api-client.js';

const IDLE_STATUS = Object.freeze({ state: 'idle' as const });
const STARTING_STATUS = Object.freeze({ state: 'starting' as const });
const STOPPING_STATUS = Object.freeze({ state: 'stopping' as const });
const CLEANUP_PENDING_STATUS = Object.freeze({ state: 'cleanupPending' as const });

export type MediaMtxServiceStatus =
  | typeof IDLE_STATUS
  | typeof STARTING_STATUS
  | { readonly state: 'running'; readonly paths: readonly MediaMtxPathStatus[] }
  | typeof STOPPING_STATUS
  | typeof CLEANUP_PENDING_STATUS;

export type MediaMtxServiceState = MediaMtxServiceStatus['state'];

export type MediaMtxServiceErrorCode =
  | 'CLEANUP_PENDING'
  | 'INSPECTION_BLOCKED'
  | 'START_ABORTED'
  | 'START_BLOCKED'
  | 'START_FAILED';

const errorMessages = {
  CLEANUP_PENDING: 'MediaMTX cleanup remains pending',
  INSPECTION_BLOCKED: 'MediaMTX inspection requires a running service',
  START_ABORTED: 'MediaMTX startup was stopped',
  START_BLOCKED: 'MediaMTX cannot start during teardown',
  START_FAILED: 'MediaMTX failed to start',
} as const satisfies Record<MediaMtxServiceErrorCode, string>;

export class MediaMtxServiceError extends Error {
  public constructor(public readonly code: MediaMtxServiceErrorCode) {
    super(errorMessages[code]);
    this.name = 'MediaMtxServiceError';
  }
}

export function projectMediaMtxServiceStatus(
  state: MediaMtxServiceState,
  paths: readonly MediaMtxPathStatus[],
): MediaMtxServiceStatus {
  switch (state) {
    case 'idle': return IDLE_STATUS;
    case 'starting': return STARTING_STATUS;
    case 'running': return Object.freeze({ state: 'running', paths });
    case 'stopping': return STOPPING_STATUS;
    case 'cleanupPending': return CLEANUP_PENDING_STATUS;
    default: return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected MediaMTX service state: ${String(value)}`);
}
