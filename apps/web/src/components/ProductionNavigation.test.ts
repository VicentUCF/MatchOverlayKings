import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductionNavigation } from './ProductionNavigation.js';

describe('production navigation', () => {
  it('exposes the two stable admin destinations and identifies the current area', () => {
    const html = renderToStaticMarkup(createElement(ProductionNavigation, {
      active: 'recordings', role: 'admin',
    }));

    expect(html).toContain('href="/admin"');
    expect(html).toContain('href="/admin/grabaciones"');
    expect(html).toContain('href="/admin/grabaciones" aria-current="page"');
    expect(html).not.toContain('href="/admin/emisiones"');
    expect(html).not.toContain('href="/mandos"');
    expect(html).not.toContain('Sistema');
  });

  it('keeps delegated operators inside Producción', () => {
    const html = renderToStaticMarkup(createElement(ProductionNavigation, {
      active: 'production', role: 'operator',
    }));

    expect(html).toContain('KPL Mandos');
    expect(html).toContain('href="/admin" aria-current="page"');
    expect(html).not.toContain('/admin/grabaciones');
    expect(html).not.toContain('Sistema');
  });

  it('shows visual control as a contextual child of Mandos', () => {
    const html = renderToStaticMarkup(createElement(ProductionNavigation, {
      active: 'visual', role: 'operator', currentLabel: 'Control visual · Pista 3',
    }));

    expect(html).toContain('href="/admin"');
    expect(html).toContain('aria-current="page">Control visual · Pista 3');
  });

  it('moves session information and secondary actions into Options', () => {
    const html = renderToStaticMarkup(createElement(ProductionNavigation, {
      active: 'production', role: 'admin', onRefresh: () => undefined, onSignOut: () => undefined,
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Opciones</span>');
    expect(html).toContain('hidden=""');
    expect(html).toContain('Administrador');
    expect(html).toContain('Actualizar datos');
    expect(html).toContain('Cerrar sesión');
  });

  it('renders admin areas as tabs when navigation is handled in place', () => {
    const html = renderToStaticMarkup(createElement(ProductionNavigation, {
      active: 'recordings', role: 'admin', onAreaChange: () => undefined,
    }));

    expect(html).toContain('role="tablist"');
    expect((html.match(/role="tab"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('id="production-tab-recordings" type="button" role="tab" aria-selected="true"');
    expect(html).not.toContain('Sistema');
  });
});
