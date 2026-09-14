import { useEffect, useState } from 'react';
import { Eye, MonitorPlay, SlidersHorizontal } from 'lucide-react';
import type { DesiredLifecycle } from '@kpl/production-contracts';
import type {
  OperatorProductionAccess,
  ProductionCourtAssignment,
  ProductionCourtSlot,
  ProductionMutationResult,
  ProductionOverviewAccess,
} from '../lib/production-overview-types.js';
import {
  desiredLifecycleLabel,
  isCapacityDeferred,
  isServerRequestPending,
} from './production-overview-presentation.js';
import { ProductionCourtDetails, ProductionStatusBadge } from './ProductionCourtDetails.js';

const LIFECYCLES = ['off', 'preflight', 'running', 'stopped'] as const satisfies readonly DesiredLifecycle[];

export type CourtCommandState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly baseVersion: number }
  | { readonly kind: 'accepted'; readonly baseVersion: number }
  | { readonly kind: 'conflict'; readonly baseVersion: number; readonly currentVersion: number }
  | { readonly kind: 'error'; readonly error: 'forbidden' | 'malformed' | 'transport' };

type ReconciliationRequest = {
  readonly access: OperatorProductionAccess;
  readonly assignment: ProductionCourtAssignment;
  readonly lifecycle: DesiredLifecycle;
  readonly refresh: () => Promise<void>;
};

type ProductionCourtCardProps = {
  readonly court: ProductionCourtSlot;
  readonly access: ProductionOverviewAccess | null;
  readonly capability: ProductionOverviewAccess['kind'];
  readonly stale: boolean;
  readonly refresh: () => Promise<void>;
};

type ProductionCourtCardViewProps = {
  readonly court: ProductionCourtSlot;
  readonly access: ProductionOverviewAccess | null;
  readonly capability: ProductionOverviewAccess['kind'];
  readonly commandState: CourtCommandState;
  readonly stale: boolean;
  readonly onReconcile: (lifecycle: DesiredLifecycle) => void;
};

export function ProductionCourtCard({ court, access, capability, stale, refresh }: ProductionCourtCardProps) {
  const [commandState, setCommandState] = useState<CourtCommandState>({ kind: 'idle' });
  const desiredVersion = court.assignment?.desired.version ?? null;

  useEffect(() => {
    setCommandState((current) => clearSettledCommand(current, desiredVersion));
  }, [desiredVersion]);

  const reconcile = async (lifecycle: DesiredLifecycle): Promise<void> => {
    if (access?.kind !== 'operator' || court.assignment === null) return;
    const assignment = court.assignment;
    setCommandState({ kind: 'pending', baseVersion: assignment.desired.version });
    setCommandState(await executeReconciliation({ access, assignment, lifecycle, refresh }));
  };

  return (
    <ProductionCourtCardView
      court={court}
      access={access}
      capability={capability}
      commandState={commandState}
      stale={stale}
      onReconcile={(lifecycle) => void reconcile(lifecycle)}
    />
  );
}

export function ProductionCourtCardView({
  court,
  access,
  capability,
  commandState,
  stale,
  onReconcile,
}: ProductionCourtCardViewProps) {
  const assignment = court.assignment;
  const feedback = commandFeedback(commandState);

  return (
    <article className="production-court-card" data-court={court.slug} aria-labelledby={`${court.slug}-title`}>
      <header className="production-court-card__header">
        <div>
          <span className="production-court-card__slug">{court.slug}</span>
          <h2 id={`${court.slug}-title`}>{court.name}</h2>
        </div>
        {!court.productionEnabled ? <ProductionStatusBadge label="Producción desactivada" tone="warning" icon="warning" /> : null}
      </header>

      {assignment === null ? (
        <div className="production-court-card__empty">
          <strong>Sin asignación</strong>
          <span>No hay una salida de producción activa para esta pista.</span>
        </div>
      ) : (
        <ProductionCourtDetails assignment={assignment} />
      )}

      {assignment !== null && access?.kind === 'operator' ? (
        <OperatorControls
          assignment={assignment}
          commandState={commandState}
          productionEnabled={court.productionEnabled}
          stale={stale}
          onReconcile={onReconcile}
        />
      ) : null}

      {feedback === null ? null : (
        <p className={`production-command-feedback ${feedback.tone}`} aria-live="polite">
          {feedback.text}
        </p>
      )}

      <CourtLinks slug={court.slug} operator={capability === 'operator'} />
    </article>
  );
}

export async function executeReconciliation(request: ReconciliationRequest): Promise<CourtCommandState> {
  const result = await request.access.reconcile(request.assignment, request.lifecycle);
  const state = mutationState(result, request.assignment.desired.version);
  if (result.kind === 'accepted' || result.kind === 'conflict') await request.refresh();
  return state;
}

function OperatorControls({ assignment, commandState, productionEnabled, stale, onReconcile }: {
  readonly assignment: ProductionCourtAssignment;
  readonly commandState: CourtCommandState;
  readonly productionEnabled: boolean;
  readonly stale: boolean;
  readonly onReconcile: (lifecycle: DesiredLifecycle) => void;
}) {
  const locked = stale || !productionEnabled || isServerRequestPending(assignment)
    || commandState.kind === 'pending' || commandState.kind === 'accepted' || commandState.kind === 'conflict';
  const deferred = isCapacityDeferred(assignment);
  return (
    <fieldset className="production-controls" disabled={locked}>
      <legend>Solicitar estado</legend>
      <div className="production-controls__options">
        {LIFECYCLES.map((lifecycle) => (
          <button
            type="button"
            key={lifecycle}
            aria-pressed={assignment.desired.desired.lifecycle === lifecycle}
            disabled={locked || (deferred && (lifecycle === 'running' || lifecycle === 'preflight'))}
            onClick={() => onReconcile(lifecycle)}
          >
            {desiredLifecycleLabel(lifecycle)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function CourtLinks({ slug, operator }: { readonly slug: string; readonly operator: boolean }) {
  return (
    <nav className="production-court-links" aria-label={`Destinos de ${slug}`}>
      {operator ? <a className="match-action primary" href={`/control/${slug}`}><SlidersHorizontal aria-hidden="true" />Mandos</a> : null}
      <a className="match-action" href={`/overlay/${slug}/scoreboard`}><MonitorPlay aria-hidden="true" />OBS</a>
      <a className="match-action" href={`/live/${slug}`}><Eye aria-hidden="true" />Público</a>
    </nav>
  );
}

function commandFeedback(state: CourtCommandState): { readonly text: string; readonly tone: 'info' | 'success' | 'danger' } | null {
  switch (state.kind) {
    case 'idle': return null;
    case 'pending': return { text: 'Enviando solicitud de reconciliación', tone: 'info' };
    case 'accepted': return { text: 'Solicitud de reconciliación aceptada', tone: 'success' };
    case 'conflict': return { text: 'La pista cambió en otro control', tone: 'danger' };
    case 'error': return { text: commandErrorLabel(state.error), tone: 'danger' };
    default: return assertNever(state);
  }
}

function commandErrorLabel(error: Extract<CourtCommandState, { readonly kind: 'error' }>['error']): string {
  switch (error) {
    case 'forbidden': return 'No tienes permiso para cambiar producción';
    case 'malformed': return 'La respuesta de producción no es válida';
    case 'transport': return 'No se pudo enviar la solicitud de reconciliación';
    default: return assertNever(error);
  }
}

function mutationState(result: ProductionMutationResult, baseVersion: number): CourtCommandState {
  switch (result.kind) {
    case 'accepted': return { kind: 'accepted', baseVersion };
    case 'conflict': return { kind: 'conflict', baseVersion, currentVersion: result.currentVersion };
    case 'forbidden': return { kind: 'error', error: 'forbidden' };
    case 'malformed': return { kind: 'error', error: 'malformed' };
    case 'transport': return { kind: 'error', error: 'transport' };
    default: return assertNever(result);
  }
}

function clearSettledCommand(state: CourtCommandState, desiredVersion: number | null): CourtCommandState {
  switch (state.kind) {
    case 'accepted':
    case 'conflict': return desiredVersion !== null && desiredVersion !== state.baseVersion ? { kind: 'idle' } : state;
    case 'idle':
    case 'pending':
    case 'error': return state;
    default: return assertNever(state);
  }
}

function assertNever(value: never): never {
  void value;
  throw new TypeError('Unexpected production card variant');
}
