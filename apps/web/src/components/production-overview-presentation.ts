import type { DesiredLifecycle, ObservedOutputState, OperationClaim } from '@kpl/production-contracts';
import type { ProductionCourtAssignment } from '../lib/production-overview-types.js';

const OBSERVED_STATUSES = [
  'running',
  'stopped',
  'capacity_deferred',
  'stop_incomplete',
  'reconciliation_failed',
  'shutdown',
  'runtime_missing',
] as const;

type ObservedStatus = (typeof OBSERVED_STATUSES)[number];

export type ObservedPresentation = {
  readonly status: ObservedStatus | 'unrecognized';
  readonly label: string;
  readonly activity: 'active' | 'inactive' | 'deferred' | 'failed' | 'unknown';
};

export type HealthPresentation = {
  readonly label: string;
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger';
  readonly icon: 'help' | 'check' | 'warning' | 'error' | 'offline';
};

export type OperationClaimPresentation = {
  readonly label: string;
  readonly tone: 'success' | 'danger' | 'info';
  readonly icon: 'check' | 'error' | 'clock';
};

export function desiredLifecycleLabel(lifecycle: DesiredLifecycle): string {
  switch (lifecycle) {
    case 'off': return 'Apagado';
    case 'preflight': return 'Preflight';
    case 'running': return 'En emisión';
    case 'stopped': return 'Detenido';
    default: return assertNever(lifecycle);
  }
}

export function observedPresentation(observed: ObservedOutputState | null): ObservedPresentation | null {
  if (observed === null) return null;
  const status = observedStatus(observed.state);
  switch (status) {
    case 'running': return { status, label: 'En emisión', activity: 'active' };
    case 'stopped': return { status, label: 'Detenido', activity: 'inactive' };
    case 'capacity_deferred': return { status, label: 'No iniciado', activity: 'deferred' };
    case 'stop_incomplete': return { status, label: 'Parada incompleta', activity: 'active' };
    case 'reconciliation_failed': return { status, label: 'Sin aplicar', activity: 'failed' };
    case 'shutdown': return { status, label: 'Agente detenido', activity: 'unknown' };
    case 'runtime_missing': return { status, label: 'Runtime ausente', activity: 'failed' };
    case 'unrecognized': return { status, label: 'Sin diagnóstico', activity: 'unknown' };
    default: return assertNever(status);
  }
}

export function healthPresentation(observed: ObservedOutputState | null): HealthPresentation {
  if (observed === null) return { label: 'Sin observación', tone: 'neutral', icon: 'help' };
  switch (observed.health) {
    case 'unknown': return { label: 'Sin diagnóstico', tone: 'neutral', icon: 'help' };
    case 'healthy': return { label: 'Saludable', tone: 'success', icon: 'check' };
    case 'degraded': return { label: 'Degradado', tone: 'warning', icon: 'warning' };
    case 'failed': return { label: 'Fallido', tone: 'danger', icon: 'error' };
    case 'offline': return { label: 'Sin conexión', tone: 'danger', icon: 'offline' };
    default: return assertNever(observed.health);
  }
}

export function operationClaimPresentation(claim: OperationClaim | null): OperationClaimPresentation | null {
  if (claim === null) return null;
  switch (claim.status) {
    case 'claimed': return { label: 'Operación en curso', tone: 'info', icon: 'clock' };
    case 'completed': return {
      label: claim.result === null ? 'Operación completada' : `Operación completada: ${claim.result.summary}`,
      tone: 'success',
      icon: 'check',
    };
    case 'failed': return {
      label: claim.result === null
        ? 'Operación fallida'
        : `Operación fallida: ${claim.result.summary} · ${claim.result.retryable ? 'Reintentable' : 'No reintentable'}`,
      tone: 'danger',
      icon: 'error',
    };
    default: return assertNever(claim.status);
  }
}

export function isCapacityDeferred(assignment: ProductionCourtAssignment): boolean {
  return observedPresentation(assignment.observed)?.activity === 'deferred';
}

export function isLifecycleMismatch(assignment: ProductionCourtAssignment): boolean {
  const observed = observedPresentation(assignment.observed);
  if (observed === null) return false;
  switch (observed.activity) {
    case 'active':
      return assignment.desired.desired.lifecycle !== 'running'
        && assignment.desired.desired.lifecycle !== 'preflight';
    case 'inactive':
      return assignment.desired.desired.lifecycle !== 'off'
        && assignment.desired.desired.lifecycle !== 'stopped';
    case 'deferred':
    case 'failed':
    case 'unknown':
      return true;
    default:
      return assertNever(observed.activity);
  }
}

export function isServerRequestPending(assignment: ProductionCourtAssignment): boolean {
  const operation = assignment.latestOperation;
  if (operation === null || operation.kind !== 'reconcile') return false;
  if (operation.commandId !== assignment.desired.commandId) return false;
  const claim = assignment.latestOperationClaim;
  if (claim !== null && claim.operationId === operation.id) {
    switch (claim.status) {
      case 'claimed': return true;
      case 'completed':
      case 'failed': return false;
      default: return assertNever(claim.status);
    }
  }
  if (assignment.observed === null) return true;
  return Date.parse(assignment.observed.reportedAt) < Date.parse(operation.createdAt);
}

function observedStatus(value: ObservedOutputState['state']): ObservedStatus | 'unrecognized' {
  if (value === null || Array.isArray(value) || typeof value !== 'object' || !('status' in value)) {
    return 'unrecognized';
  }
  const status = value.status;
  return typeof status === 'string' && isObservedStatus(status) ? status : 'unrecognized';
}

function isObservedStatus(value: string): value is ObservedStatus {
  return OBSERVED_STATUSES.some((status) => status === value);
}

function assertNever(value: never): never {
  void value;
  throw new TypeError('Unexpected production presentation variant');
}
