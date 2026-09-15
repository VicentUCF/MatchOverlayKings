import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OperationClaim } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { ProductionCourtCardView } from './ProductionCourtCard.js';
import { ProductionOverviewView } from './ProductionOverview.js';
import type { ProductionOverviewState } from '../hooks/useProductionOverview.js';
import { mapProductionOverviewData } from '../lib/production-overview-mapper.js';
import { productionDataset, USER_ID } from '../lib/production-overview-test-fixtures.js';
import type {
  OperatorProductionAccess,
  ProductionCourtAssignment,
  ProductionCourtSlot,
  ProductionOverviewSnapshot,
} from '../lib/production-overview-types.js';

function snapshot(): ProductionOverviewSnapshot {
  const mapped = mapProductionOverviewData(USER_ID, productionDataset());
  if (mapped.kind !== 'success') throw new TypeError('Production overview fixture did not map');
  return mapped.snapshot;
}

function operatorAccess(value = snapshot()): OperatorProductionAccess {
  return { kind: 'operator', snapshot: value, reconcile: async () => ({ kind: 'transport' }) };
}

function assignmentFrom(value: ProductionOverviewSnapshot): ProductionCourtAssignment {
  const assignment = firstCourt(value).assignment;
  if (assignment === null) throw new TypeError('Production overview fixture has no assignment');
  return assignment;
}

function renderOverview(state: ProductionOverviewState): string {
  return renderToStaticMarkup(createElement(ProductionOverviewView, {
    state,
    refresh: async () => undefined,
    signOut: async () => undefined,
  }));
}

function renderAssignment(assignment: ProductionCourtAssignment): string {
  const value = snapshot();
  const court: ProductionCourtSlot = { ...firstCourt(value), assignment };
  return renderToStaticMarkup(createElement(ProductionCourtCardView, {
    court,
    access: operatorAccess(value),
    capability: 'operator',
    commandState: { kind: 'idle' },
    stale: false,
    onReconcile: () => undefined,
  }));
}

function firstCourt(value: ProductionOverviewSnapshot): ProductionCourtSlot {
  const court = value.courts[0];
  if (court === undefined) throw new TypeError('Production overview fixture has no courts');
  return court;
}

describe('production overview retained access', () => {
  it.each([
    [{ kind: 'refreshing', refreshing: true }, 'Actualizando'],
    [{ kind: 'stale', error: { kind: 'transport' } }, 'Reintentar'],
  ] satisfies readonly (readonly [
    Omit<Extract<ProductionOverviewState, { readonly kind: 'refreshing' }>, 'access'>
      | Omit<Extract<ProductionOverviewState, { readonly kind: 'stale' }>, 'access'>,
    string,
  ])[])('keeps operator controls and links visible but disabled for $kind', (state, actionLabel) => {
    const access = operatorAccess();
    const html = renderOverview({ ...state, access });

    expect(html).toContain('Solicitar estado');
    expect(html).toContain('<fieldset class="production-controls" disabled="">');
    expect(html).toContain('Mandos');
    expect(html).toContain('OBS');
    expect(html).toContain('Público');
    expect(html).toContain(actionLabel);
  });
});

describe('production operation claim presentation', () => {
  it.each([
    ['claimed', null, 'Operación en curso'],
    ['completed', { summary: 'Emisión iniciada', retryable: false }, 'Operación completada: Emisión iniciada'],
    ['failed', { summary: 'FFmpeg no respondió', retryable: true }, 'Operación fallida: FFmpeg no respondió · Reintentable'],
    ['failed', { summary: 'Perfil incompatible', retryable: false }, 'Operación fallida: Perfil incompatible · No reintentable'],
  ] satisfies readonly (readonly [OperationClaim['status'], OperationClaim['result'], string])[])(
    'renders an explicit accessible %s claim outcome',
    (status, result, expected) => {
      const value = snapshot();
      const assignment = assignmentFrom(value);
      if (assignment.latestOperationClaim === null) throw new TypeError('Production fixture has no operation claim');
      const html = renderAssignment({
        ...assignment,
        latestOperationClaim: { ...assignment.latestOperationClaim, status, result },
      });

      expect(html).toContain(`role="status"`);
      expect(html).toContain(expected);
    },
  );

  it('renders details in event, lifecycle, health/operation, report metadata order', () => {
    const html = renderAssignment(assignmentFrom(snapshot()));
    const sections = [
      'production-context',
      'production-lifecycle',
      'production-observed',
      'production-observation-meta',
    ].map((className) => html.indexOf(className));

    expect(sections.every((position) => position >= 0)).toBe(true);
    expect(sections).toEqual([...sections].sort((left, right) => left - right));
  });
});
