import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import type { ProductionCourtAssignment } from '../lib/production-overview-types.js';
import {
  desiredLifecycleLabel,
  healthPresentation,
  isCapacityDeferred,
  isLifecycleMismatch,
  isServerRequestPending,
  observedPresentation,
  operationClaimPresentation,
} from './production-overview-presentation.js';

export function ProductionCourtDetails({ assignment }: { readonly assignment: ProductionCourtAssignment }) {
  const health = healthPresentation(assignment.observed);
  const observed = observedPresentation(assignment.observed);
  const mismatch = isLifecycleMismatch(assignment);
  const capacityDeferred = isCapacityDeferred(assignment);
  const serverPending = isServerRequestPending(assignment);
  const claim = operationClaimPresentation(assignment.latestOperationClaim);
  return (
    <div className="production-court-card__details">
      <section className="production-context" aria-label="Evento y marcador">
        <div><span>Evento</span><strong>{assignment.event.title}</strong></div>
        <p>{eventStatusLabel(assignment.event.status)} · Salida {assignment.output.name}</p>
        {assignment.score === null ? <p>Marcador sin datos</p> : (
          <p>{assignment.score.title} · {assignment.score.homeTeamId} vs {assignment.score.awayTeamId} · v{assignment.score.version}</p>
        )}
      </section>
      <dl className="production-lifecycle">
        <div><dt>Deseado</dt><dd>{desiredLifecycleLabel(assignment.desired.desired.lifecycle)}</dd></div>
        <div><dt>Observado</dt><dd>{observed?.label ?? '—'}</dd></div>
      </dl>
      {mismatch ? <p className="production-inline-state warning">Pendiente de reconciliación</p> : null}
      <section className="production-observed" aria-label="Salud y operación">
        <ProductionStatusBadge {...health} />
        {claim === null
          ? serverPending ? <ProductionStatusBadge label="Solicitud en curso" tone="info" icon="clock" /> : null
          : <span role="status" aria-live="polite"><ProductionStatusBadge {...claim} /></span>}
        {capacityDeferred ? <ProductionStatusBadge label="En espera de capacidad" tone="warning" icon="warning" /> : null}
      </section>
      <dl className="production-observation-meta">
        <div><dt>Último reporte</dt><dd>{assignment.observed === null ? 'Sin reporte' : <Timestamp value={assignment.observed.reportedAt} />}</dd></div>
        <div><dt>Secuencia</dt><dd>{assignment.observed?.sequence ?? '—'}</dd></div>
      </dl>
    </div>
  );
}

export function ProductionStatusBadge({ label, tone, icon }: {
  readonly label: string;
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  readonly icon: 'help' | 'check' | 'warning' | 'error' | 'offline' | 'clock';
}) {
  const Icon = statusIcon(icon);
  return <span className={`production-status ${tone}`}><Icon aria-hidden="true" /><span>{label}</span></span>;
}

function statusIcon(icon: 'help' | 'check' | 'warning' | 'error' | 'offline' | 'clock') {
  switch (icon) {
    case 'help': return CircleHelp;
    case 'check': return CircleCheck;
    case 'warning': return TriangleAlert;
    case 'error': return CircleX;
    case 'offline': return WifiOff;
    case 'clock': return Clock3;
    default: return assertNever(icon);
  }
}

function Timestamp({ value }: { readonly value: string }) {
  return <time dateTime={value} aria-label={value}>{new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))}</time>;
}

function eventStatusLabel(status: ProductionCourtAssignment['event']['status']): string {
  switch (status) {
    case 'scheduled': return 'Programado';
    case 'ready': return 'Preparado';
    case 'live': return 'En directo';
    case 'completed': return 'Completado';
    case 'cancelled': return 'Cancelado';
    default: return assertNever(status);
  }
}

function assertNever(value: never): never {
  void value;
  throw new TypeError('Unexpected production detail variant');
}
