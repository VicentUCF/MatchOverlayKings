# CSS architecture

The stylesheet entrypoint is `global.css`. It only imports files in ITCSS order:

1. `settings`: design tokens and global custom properties.
2. `generic`: reset and document-level behavior.
3. `elements`: unclassed HTML element defaults.
4. `objects`: shared layout scaffolding.
5. `components`: reusable UI blocks.
6. `pages`: route-level composition.
7. `overlays`: OBS/broadcast surfaces with highly specific rules.
8. `responsive`: cross-cutting viewport overrides.

Keep new CSS close to the component, page, or overlay it belongs to. Before adding a new file, prefer extending an existing responsibility bucket. Before adding a duplicated rule, extract a shared token or component rule.

Refactoring rules for this project:

- Obvious placement beats clever abstraction.
- Avoid duplicated declarations for the same behavior.
- Keep global scope limited to tokens, reset, and base element rules.
- Treat overlay styles as a separate product surface; they intentionally stay isolated from app chrome.
- Run the web build after moving CSS imports.
