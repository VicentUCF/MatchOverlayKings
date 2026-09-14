import type { ReportObservedStateCommand } from '@kpl/production-contracts';
import type { CourtSnapshot } from './config.js';
import type { CourtWorkerResult } from './orchestration-models.js';

export class ObservedStateProjectionError extends Error {
  public readonly code = 'INVALID_RECONCILIATION_RESULT' as const;

  public constructor() {
    super('Invalid reconciliation result for observed state');
    this.name = 'ObservedStateProjectionError';
  }
}

export class ObservedStateProjector {
  private readonly sequences = new Map<string, number>();

  public project(snapshot: CourtSnapshot, result: CourtWorkerResult): ReportObservedStateCommand {
    if (snapshot.output.courtId !== result.courtId) throw new ObservedStateProjectionError();
    const observedSequence = snapshot.observed?.sequence ?? -1;
    const sequence = Math.max(observedSequence, this.sequences.get(snapshot.output.id) ?? -1) + 1;
    this.sequences.set(snapshot.output.id, sequence);
    return { outputId: snapshot.output.id, sequence, ...projectResult(snapshot, result) };
  }
}

function projectResult(
  snapshot: CourtSnapshot,
  result: CourtWorkerResult,
): Pick<ReportObservedStateCommand, 'health' | 'state'> {
  switch (result.kind) {
    case 'reconciled': {
      if (result.reconciliation.outputId !== snapshot.output.id) throw new ObservedStateProjectionError();
      switch (result.reconciliation.action.kind) {
        case 'stop':
          return result.runtime === null
            ? { health: 'offline', state: { status: 'stopped' } }
            : { health: 'failed', state: { status: 'stop_incomplete' } };
        case 'noop':
          if (result.reconciliation.action.reason === 'desired-inactive') {
            return result.runtime === null
              ? { health: 'offline', state: { status: 'stopped' } }
              : { health: 'failed', state: { status: 'stop_incomplete' } };
          }
          return result.runtime === null ? missingRuntime() : runningRuntime(result.runtime);
        case 'start':
        case 'restart':
          return result.runtime === null ? missingRuntime() : runningRuntime(result.runtime);
        default:
          return assertNever(result.reconciliation.action);
      }
    }
    case 'degraded':
      if (result.outputId !== snapshot.output.id) throw new ObservedStateProjectionError();
      return { health: 'degraded', state: { status: 'capacity_deferred' } };
    case 'failed':
      return { health: 'failed', state: { status: 'reconciliation_failed' } };
    case 'cancelled':
      return { health: 'unknown', state: { status: 'shutdown' } };
    default:
      return assertNever(result);
  }
}

function missingRuntime(): Pick<ReportObservedStateCommand, 'health' | 'state'> {
  return { health: 'failed', state: { status: 'runtime_missing' } };
}

function runningRuntime(
  runtime: NonNullable<Extract<CourtWorkerResult, { readonly kind: 'reconciled' }>['runtime']>,
): Pick<ReportObservedStateCommand, 'health' | 'state'> {
  return {
    health: 'healthy',
    state: {
      status: 'running',
      appliedDesiredVersion: runtime.appliedDesiredVersion,
      profileFingerprint: runtime.profileFingerprint,
    },
  };
}

function assertNever(value: never): never {
  void value;
  throw new ObservedStateProjectionError();
}
