import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const controlsCss = readFileSync(
  new URL('../styles/components/production-controls.css', import.meta.url),
  'utf8',
);
const courtCardCss = readFileSync(
  new URL('../styles/components/production-court-card.css', import.meta.url),
  'utf8',
);
const resetCss = readFileSync(
  new URL('../styles/generic/reset.css', import.meta.url),
  'utf8',
);
const overviewCss = readFileSync(
  new URL('../styles/pages/production-overview.css', import.meta.url),
  'utf8',
);

function declarationsFor(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarations = new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (declarations === undefined) throw new TypeError(`Missing CSS selector: ${selector}`);
  return declarations;
}

describe('production overview accessibility styles', () => {
  it('uses border-box sizing for elements and their generated content', () => {
    expect(resetCss).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*box-sizing: border-box;/);
  });

  it('keeps every workspace panel inside the shared production container', () => {
    const declarations = declarationsFor(overviewCss, '.production-workspace-panel');

    expect(declarations).toContain('width: min(100%, var(--kpl-container-xl));');
    expect(declarations).toContain('min-width: 0;');
    expect(declarations).toContain('margin-inline: auto;');
  });

  it('uses the production control-size token for interactive target heights', () => {
    expect(declarationsFor(controlsCss, '.production-overview-page .refresh-button')).toContain(
      'min-height: var(--kpl-control-size-md);',
    );
    expect(declarationsFor(controlsCss, '.production-controls button')).toContain(
      'min-height: var(--kpl-control-size-md);',
    );
    expect(declarationsFor(controlsCss, '.production-court-links .match-action')).toContain(
      'min-height: var(--kpl-control-size-md);',
    );
  });

  it('keeps potentially icon-sized production actions at least control width', () => {
    expect(declarationsFor(controlsCss, '.production-overview-page .refresh-button')).toContain(
      'min-width: var(--kpl-control-size-md);',
    );
    expect(declarationsFor(controlsCss, '.production-court-links .match-action')).toContain(
      'min-width: var(--kpl-control-size-md);',
    );
  });

  it('keeps disabled lifecycle controls visibly disabled without obscuring their labels', () => {
    expect(declarationsFor(controlsCss, '.production-controls button:disabled')).toContain(
      'opacity: 0.65;',
    );
  });

  it('disables action motion and neutralizes moving interaction states for reduced motion', () => {
    expect(controlsCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none;/);
    expect(controlsCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none;/);
    expect(controlsCss).toMatch(/\.production-overview-page \.refresh-button:focus-visible:not\(:disabled\)[\s\S]*transform: none;/);
    expect(controlsCss).toMatch(/\.production-controls button:focus-visible:not\(:disabled\)[\s\S]*transform: none;/);
    expect(controlsCss).toMatch(/\.production-court-links \.match-action:focus-visible[\s\S]*transform: none;/);
  });

  it('disables production card and status motion for reduced motion', () => {
    expect(courtCardCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.production-court-card[\s\S]*animation: none;/);
    expect(courtCardCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.production-status[\s\S]*transition: none;/);
  });
});
