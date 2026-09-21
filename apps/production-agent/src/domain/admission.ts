import type { CourtId, DesiredLifecycle } from '@kpl/production-contracts';
import type { PipelineRuntime } from './models.js';

export type AdmissionCandidate = {
  readonly courtId: CourtId;
  readonly lifecycle: DesiredLifecycle;
  readonly runtime: PipelineRuntime | null;
  readonly inspectable: boolean;
};

class UnexpectedAdmissionLifecycleError extends Error {
  public constructor() {
    super('Unexpected admission lifecycle');
    this.name = 'UnexpectedAdmissionLifecycleError';
  }
}

export function selectAdmissions(
  candidates: readonly AdmissionCandidate[],
  capacity: number,
): ReadonlySet<CourtId> {
  const selected = new Set<CourtId>();

  for (const candidate of candidates) {
    if (
      selected.size < capacity &&
      candidate.inspectable &&
      candidate.runtime !== null &&
      isActiveLifecycle(candidate.lifecycle)
    ) {
      selected.add(candidate.courtId);
    }
  }

  return selected;
}

export function isActiveLifecycle(lifecycle: DesiredLifecycle): boolean {
  switch (lifecycle) {
    case 'running':
    case 'preflight':
      return true;
    case 'off':
    case 'stopped':
      return false;
    default:
      return assertNever(lifecycle);
  }
}

function assertNever(value: never): never {
  void value;
  throw new UnexpectedAdmissionLifecycleError();
}
