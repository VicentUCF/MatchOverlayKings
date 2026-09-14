import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProductionPilotController } from '../hooks/useProductionPilot.js';
import { ProductionTabbedWorkspace } from './ProductionOverview.js';

const pilot: ProductionPilotController = {
  state: { kind: 'loading' },
  refresh: async () => undefined,
  configure: async () => false,
  createMobileCamera: async () => null,
  updateMobileCamera: async () => false,
  revokeMobileCamera: async () => false,
  prepare: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

describe('tabbed production workspace', () => {
  it('keeps Inicio, Emisiones and Mandos mounted with one shared controller', () => {
    const html = renderToStaticMarkup(createElement(ProductionTabbedWorkspace, {
      initialArea: 'dashboard', pilot, signOut: async () => undefined,
    }));

    expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(3);
    expect((html.match(/class="production-workspace-panel"/g) ?? [])).toHaveLength(3);
    expect((html.match(/role="tabpanel"[^>]*hidden=""/g) ?? [])).toHaveLength(2);
    expect(html).toContain('Las tres pistas, en un solo sitio');
    expect(html).toContain('Cargando el centro de emisiones');
    expect(html).not.toContain('Sistema');
  });
});
