import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClubIdSchema, PrincipalIdSchema } from '@kpl/production-contracts';
import { ProductionOverviewView } from './ProductionOverview.js';
import { ProductionSetupWorkspaceView } from './ProductionSetupWorkspace.js';
import { createProductionSetupDraft, type ProductionSetupInventory } from '../lib/production-setup-orchestrator.js';
import type { ProductionOverviewState } from '../hooks/useProductionOverview.js';
import { PRODUCTION_COURT_SLUGS, type ProductionOverviewAccess, type ProductionOverviewSnapshot } from '../lib/production-overview-types.js';

const CLUB_ID = '10000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = '20000000-0000-4000-8000-000000000001';

function inventory(): ProductionSetupInventory {
  return {
    eventDays: [], principals: [], devices: [], events: [], assignments: [], outputs: [],
    courts: PRODUCTION_COURT_SLUGS.map((slug, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      clubId: CLUB_ID, slug, name: `Pista ${index + 1}`, productionEnabled: true,
    })),
  };
}

function access(kind: ProductionOverviewAccess['kind']): ProductionOverviewAccess {
  const snapshot: ProductionOverviewSnapshot = {
    clubId: ClubIdSchema.parse(CLUB_ID), principalId: PrincipalIdSchema.parse(PRINCIPAL_ID), loadedAt: '2026-09-14T10:00:00.000Z',
    courts: [
      { slug: 'pista-1', courtId: '30000000-0000-4000-8000-000000000001', name: 'Pista 1', productionEnabled: true, assignment: null },
      { slug: 'pista-2', courtId: '30000000-0000-4000-8000-000000000002', name: 'Pista 2', productionEnabled: true, assignment: null },
      { slug: 'pista-3', courtId: '30000000-0000-4000-8000-000000000003', name: 'Pista 3', productionEnabled: true, assignment: null },
      { slug: 'pista-4', courtId: '30000000-0000-4000-8000-000000000004', name: 'Pista 4', productionEnabled: true, assignment: null },
    ],
  };
  return kind === 'viewer'
    ? { kind, snapshot }
    : { kind, snapshot, reconcile: async () => ({ kind: 'transport' }) };
}

function overviewHtml(kind: ProductionOverviewAccess['kind']): string {
  const state: ProductionOverviewState = { kind: 'ready', access: access(kind), refreshing: false };
  return renderToStaticMarkup(createElement(ProductionOverviewView, {
    state, refresh: async () => undefined, signOut: async () => undefined, onOpenSetup: () => undefined,
  }));
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) return '';
  return Children.toArray(node.props.children).map(textContent).join('');
}

function findButtonAction(node: ReactNode, label: string): (() => void) | undefined {
  if (!isValidElement<{ readonly children?: ReactNode; readonly onClick?: () => void }>(node)) return undefined;
  if (node.type === 'button' && textContent(node) === label) return node.props.onClick;
  for (const child of Children.toArray(node.props.children)) {
    const action = findButtonAction(child, label);
    if (action !== undefined) return action;
  }
  return undefined;
}

describe('production setup workspace', () => {
  it('exposes setup from the operator overview but not the viewer overview', () => {
    expect(overviewHtml('operator')).toContain('Configurar producción');
    expect(overviewHtml('viewer')).not.toContain('Configurar producción');
  });

  it('renders one shared panel and exactly four fixed court forms in source order', () => {
    let sequence = 0;
    const currentInventory = inventory();
    const draft = createProductionSetupDraft(currentInventory, CLUB_ID, () =>
      `40000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    );
    const html = renderToStaticMarkup(createElement(ProductionSetupWorkspaceView, {
      state: { kind: 'ready', inventory: currentInventory, draft, progress: null, dirty: false },
      onSharedChange: () => undefined, onCourtChange: () => undefined,
      onSubmit: () => undefined, onBack: () => undefined,
    }));

    const positions = ['pista-1', 'pista-2', 'pista-3', 'pista-4'].map((slug) => html.indexOf(`data-setup-court="${slug}"`));
    expect((html.match(/data-setup-court=/g) ?? []).length).toBe(4);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect((html.match(/name="agentAuthUserId"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-describedby="agent-auth-help"');
    expect((html.match(/Agente compartido/g) ?? []).length).toBe(4);
    expect(html).toContain('Formato requerido: local://captura/pista.');
    expect(html).toContain('SRT');
    expect(html).toContain('Programa');
    expect(html).toContain('tres canalizaciones');
  });

  it.each(['malformed', 'transport'] satisfies readonly ('malformed' | 'transport')[])(
    'offers a working inventory retry for an initial %s failure',
    (error) => {
      const onRefresh = vi.fn();
      const view = ProductionSetupWorkspaceView({ state: { kind: 'error', error }, onRefresh });

      const retry = findButtonAction(view, 'Reintentar inventario');

      expect(retry).toBeTypeOf('function');
      if (retry === undefined) return;
      retry();
      expect(onRefresh).toHaveBeenCalledOnce();
    },
  );

  it('keeps forbidden inventory failures non-retryable', () => {
    const view = ProductionSetupWorkspaceView({ state: { kind: 'forbidden' } });

    const retry = findButtonAction(view, 'Reintentar inventario');

    expect(retry).toBeUndefined();
  });
});
