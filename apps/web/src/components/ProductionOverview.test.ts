import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesiredLifecycle } from '@kpl/production-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  ProductionCourtCardView,
  executeReconciliation,
  type CourtCommandState,
} from './ProductionCourtCard.js';
import { ProductionOverviewView } from './ProductionOverview.js';
import type { ProductionOverviewState } from '../hooks/useProductionOverview.js';
import { mapProductionOverviewData } from '../lib/production-overview-mapper.js';
import { productionDataset, USER_ID } from '../lib/production-overview-test-fixtures.js';
import type {
  OperatorProductionAccess,
  ProductionCourtAssignment,
  ProductionCourtSlot,
  ProductionMutationResult,
  ProductionOverviewSnapshot,
  ViewerProductionAccess,
} from '../lib/production-overview-types.js';

function snapshot(role: 'operator' | 'viewer' = 'operator'): ProductionOverviewSnapshot {
  const mapped = mapProductionOverviewData(USER_ID, productionDataset(role));
  if (mapped.kind !== 'success') throw new TypeError('Production overview fixture did not map');
  return mapped.snapshot;
}

function assignmentFrom(value: ProductionOverviewSnapshot): ProductionCourtAssignment {
  const assignment = firstCourt(value).assignment;
  if (assignment === null) throw new TypeError('Production overview fixture has no assignment');
  return assignment;
}

function firstCourt(value: ProductionOverviewSnapshot): ProductionCourtSlot {
  const court = value.courts[0];
  if (court === undefined) throw new TypeError('Production overview fixture has no courts');
  return court;
}

function renderOverview(state: ProductionOverviewState): string {
  return renderToStaticMarkup(createElement(ProductionOverviewView, {
    state,
    refresh: async () => undefined,
    signOut: async () => undefined,
  }));
}

function viewerAccess(value = snapshot('viewer')): ViewerProductionAccess {
  return { kind: 'viewer', snapshot: value };
}

function operatorAccess(
  reconcile: OperatorProductionAccess['reconcile'] = async () => ({ kind: 'transport' }),
  value = snapshot(),
): OperatorProductionAccess {
  return { kind: 'operator', snapshot: value, reconcile };
}

function renderCourt(
  court: ProductionCourtSlot,
  access: ViewerProductionAccess | OperatorProductionAccess,
  commandState: CourtCommandState = { kind: 'idle' },
): string {
  return renderToStaticMarkup(createElement(ProductionCourtCardView, {
    court,
    access,
    capability: access.kind,
    commandState,
    stale: false,
    onReconcile: () => undefined,
  }));
}

describe('production overview components', () => {
  it('does not invent fixed court identities while loading authoritative inventory', () => {
    const html = renderOverview({ kind: 'loading' });

    expect((html.match(/<article/g) ?? []).length).toBe(1);
    expect(html).toContain('Consultando la configuración autoritativa');
    expect(html).not.toContain('pista-1');
  });

  it('keeps no-assignment slots inside the successful four-card overview', () => {
    const value = snapshot('viewer');
    const html = renderOverview({ kind: 'ready', access: viewerAccess(value), refreshing: false });

    expect((html.match(/<article/g) ?? []).length).toBe(4);
    expect((html.match(/Sin asignación/g) ?? []).length).toBe(3);
  });

  it('omits mutation controls and Mandos for viewer access', () => {
    const value = snapshot('viewer');
    const html = renderCourt(firstCourt(value), viewerAccess(value));

    expect(html).not.toContain('Mandos');
    expect(html).not.toContain('Solicitar estado');
    expect(html).toContain('OBS');
    expect(html).toContain('Público');
  });

  it('renders operator lifecycle controls and all existing destinations', () => {
    const value = snapshot();
    const court = firstCourt(value);
    const html = renderCourt(court, operatorAccess(undefined, value));

    expect(html).toContain('Solicitar estado');
    expect(html).toContain('Apagado');
    expect(html).toContain('Preflight');
    expect(html).toContain('En emisión');
    expect(html).toContain('Detenido');
    expect(html).toContain('Mandos');
    expect(html).toContain(`/control/${court.slug}`);
    expect(html).toContain(`/overlay/${court.slug}/scoreboard`);
    expect(html).toContain(`/live/${court.slug}`);
  });

  it('disables every lifecycle control while a request is pending', () => {
    const value = snapshot();
    const court = firstCourt(value);
    const html = renderCourt(court, operatorAccess(undefined, value), {
      kind: 'pending',
      baseVersion: assignmentFrom(value).desired.version,
    });

    expect(html).toContain('Enviando solicitud de reconciliación');
    expect((html.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(4);
  });

  it.each([
    [{ kind: 'accepted', baseVersion: 3 }, 'Solicitud de reconciliación aceptada'],
    [{ kind: 'conflict', baseVersion: 3, currentVersion: 4 }, 'La pista cambió en otro control'],
    [{ kind: 'error', error: 'forbidden' }, 'No tienes permiso para cambiar producción'],
    [{ kind: 'error', error: 'malformed' }, 'La respuesta de producción no es válida'],
    [{ kind: 'error', error: 'transport' }, 'No se pudo enviar la solicitud de reconciliación'],
  ] satisfies readonly (readonly [CourtCommandState, string])[])('shows command outcome %s', (commandState, text) => {
    const value = snapshot();

    expect(renderCourt(firstCourt(value), operatorAccess(undefined, value), commandState)).toContain(text);
  });

  it('renders capacity deferral from observed state without replacing desired or observed truth', () => {
    const value = snapshot();
    const court = firstCourt(value);
    const assignment = assignmentFrom(value);
    if (assignment.observed === null) throw new TypeError('Production fixture has no observation');
    const deferredCourt: ProductionCourtSlot = {
      ...court,
      assignment: {
        ...assignment,
        observed: {
          ...assignment.observed,
          health: 'degraded',
          state: { status: 'capacity_deferred' },
        },
      },
    };

    const html = renderCourt(deferredCourt, operatorAccess(undefined, value));

    expect(html).toContain('En espera de capacidad');
    expect(html).toContain('Deseado');
    expect(html).toContain('En emisión');
    expect(html).toContain('Observado');
    expect(html).toContain('No iniciado');
  });
});

describe('production reconciliation execution', () => {
  it.each([
    [{ kind: 'accepted', acknowledgement: 'reconciliation_requested', desired: assignmentFrom(snapshot()).desired }, true],
    [{ kind: 'conflict', currentVersion: 4 }, true],
    [{ kind: 'forbidden' }, false],
    [{ kind: 'malformed' }, false],
    [{ kind: 'transport' }, false],
  ] satisfies readonly (readonly [ProductionMutationResult, boolean])[])('handles %s exhaustively', async (result, refreshes) => {
    const value = snapshot();
    const reconcile = vi.fn(async () => result);
    const refresh = vi.fn(async () => undefined);
    const lifecycle: DesiredLifecycle = 'stopped';

    const commandState = await executeReconciliation({
      access: operatorAccess(reconcile, value),
      assignment: assignmentFrom(value),
      lifecycle,
      refresh,
    });

    expect(reconcile).toHaveBeenCalledWith(assignmentFrom(value), lifecycle);
    expect(refresh).toHaveBeenCalledTimes(refreshes ? 1 : 0);
    expect(commandState.kind).toBe(result.kind === 'accepted' ? 'accepted' : result.kind === 'conflict' ? 'conflict' : 'error');
  });
});
