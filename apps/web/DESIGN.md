# KPL Four-Court Production Overview

Implementation contract for the production overview that will extend the authenticated `/admin` surface. It codifies the current KPL web language; it is not a redesign or a new public design-system API.

## 0. Research Log

- Web shell and routes: inspected `AdminPage`, `HomePage`, `ControlPage`, `LivePage`, `Scoreboard`, and `App`; `/admin` owns authentication and the current deep links are `/control/:courtSlug`, `/live/:courtSlug`, and `/overlay/:courtSlug/scoreboard`.
- Web styling: inspected `global.css`, its ITCSS import order, `home-admin.css`, `control.css`, responsive rules, and the brand, match-list, panel, form, action, segmented-control, tab, modal, toast, and broadcast patterns.
- Shared system: inspected the local `@kpl/design-system` dependency and its tokens, fonts, layout objects, actions, surfaces, forms, feedback, data-display, base, component catalog, and migration guidance at `/home/vicent_ucf/Documents/Projects/kpl-design-system`.
- Production semantics: inspected repository contracts for roles, desired lifecycles, observed health, operations, adapter errors, and capacity admission. No external visual references were used because preserving the existing KPL surface is the requirement.

## 1. Scope, Roles, and Hierarchy

The overview is a quiet, high-signal broadcast control room: near-black layered surfaces, restrained gold emphasis, cyan only where broadcast context benefits, and health colors reserved for status. Keep the current KPL wordmark, typography, compact radius, subtle rim light, and shallow lift; add no new brand assets.

`/admin` remains the authentication shell. Its signed-out login, session handling, refresh, and sign-out behavior are unchanged. After authentication, the existing event list area becomes the production overview; manual route parsing and the rest of the application remain unchanged.

Roles follow the production contracts:

- **Viewer:** read-only overview, status detail, score summary, and authorized navigation links. Render no desired-state controls and expose no mutation through hidden shortcuts.
- **Operator:** all viewer information plus desired-state controls. Controls request `off`, `preflight`, `running`, or `stopped`, and may request reconciliation; they never claim direct process control.
- **Manager:** an authorized operator who may open the scoped production setup workspace before using the same overview. Setup creates the minimum production records described below; it does not grant Auth administration, secret handling, or direct runtime control.
- A forbidden response is an authorization state, not an empty overview. Do not infer a role from UI state or expose operator controls while permissions are unresolved.

Information order is fixed:

1. Existing admin top bar: KPL identity, signed-in role, refresh, sign out.
2. Page header: `Producción · cuatro pistas`, one-sentence system summary, and last successful refresh time.
3. Four court cards in immutable DOM and visual order: `pista-1`, `pista-2`, `pista-3`, `pista-4`.
4. Per-card order: court identity and assignment; score/event context; observed health; desired versus observed lifecycle; pending/conflict/deferred feedback; role-appropriate controls; existing route links; observation metadata.

Never sort, hide, collapse, or replace court slots based on assignment or health. A missing assignment is represented inside its court card so operators retain spatial memory.

### Manager Setup Workspace

The manager-facing setup workspace is a bounded preparation view inside the authenticated `/admin` production area, not a replacement for the lifecycle overview or a new application route. A manager enters it from the overview when setup is incomplete, completes or resumes the shared four-court configuration, then returns to the existing overview in the same authenticated shell.

The runnable MVP represents one active event day with this exact shape:

1. One shared local agent principal, linked to one externally pre-created Supabase Auth UUID, is assigned to all four events.
2. Each fixed court, `pista-1` through `pista-4`, has one local capture device.
3. Each court has one fixed schedule for the active event day, one capture assignment to its local device, one agent assignment to the shared principal, and one enabled program output for its event.
4. Each enabled output uses local loopback SRT. The current local agent executes this transport through its local MediaMTX composition.

The database may accept `rtmp`, `hls`, and `local` transport values, but they are not selectable runnable outputs in this MVP. The setup workspace presents only the fixed local loopback SRT choice and must not imply support for YouTube, network cameras, remote ingest, or another transport.

All UUID inputs are references to externally pre-created Supabase Auth users. Capture-device references and local media references accept only a `local://` value. Secret values, credentials, tokens, and media passwords never enter browser fields, client state, browser storage, telemetry, or logs. The workspace stores only the accepted redacted `local://` references through the existing manager RPCs.

## 2. Tokens and Visual Language

Use canonical tokens already exported by `@kpl/design-system`; do not add page-specific color, type, spacing, radius, shadow, or timing values. Historical aliases may remain in existing CSS but new overview rules use `--kpl-*` names. `global.css` currently imports only the shared `tokens` entry, so shared `c-*` and `o-*` classes are not runtime dependencies of this contract; keep using the app's loaded local components rather than pretending those classes are available.

| Intent | Existing token(s) | Contract |
| --- | --- | --- |
| Page and layered surfaces | `--kpl-color-background`, `--kpl-color-surface`, `--kpl-color-surface-raised`, `--kpl-color-surface-emphasis` | Preserve the current dark radial atmosphere and layered operator panels. |
| Text | `--kpl-color-text-strong`, `--kpl-color-text`, `--kpl-color-text-muted` | Strong for court/status facts, default for body, muted for timestamps and IDs. |
| Brand/action | `--kpl-color-brand`, `--kpl-color-brand-strong`, `--kpl-color-brand-contrast` | Gold is for the primary operator action, current selection, and focus-related emphasis, not decoration. |
| Broadcast accent | `--kpl-color-accent-alt` | Optional secondary accent for live/transport context only; never substitute for health semantics. |
| Status | `--kpl-color-success`, `--kpl-color-warning`, `--kpl-color-danger`, `--kpl-color-info` | Healthy; degraded/stale/mismatch/deferred; failed/offline/conflict/error; pending/informational. Always pair with text. |
| Borders/focus | `--kpl-color-border-subtle`, `--kpl-color-border-strong`, `--kpl-color-focus`, `--kpl-border-width` | Subtle card separation, stronger active/warning rim, visible focus. |
| Type | `--kpl-font-family-body`, `--kpl-font-family-heading`, `--kpl-font-size-50` through `--kpl-font-size-700`, `--kpl-line-height-*`, `--kpl-letter-spacing-*` | Manrope body; Space Grotesk headings, court names, and tabular production values. Body copy is never below `--kpl-font-size-100`. |
| Rhythm | `--kpl-space-1` through `--kpl-space-12` | Use the existing 4px-derived scale only. Compact metadata uses 1-2, controls 2-4, card padding 4, card internals 3-5, page regions 7-9. |
| Shape/elevation | `--kpl-radius-xs`, `--kpl-radius-pill`, `--kpl-shadow-sm`, `--kpl-shadow-md` | Cards and controls retain the current compact `--kpl-radius-xs`; statuses use pill shape. Avoid new large-radius styling. |
| Motion | `--kpl-duration-fast`, `--kpl-duration-normal`, `--kpl-duration-slow`, `--kpl-ease-standard` | Feedback only; no decorative looping motion. |

Surface recipe: use the current mixed strategy of tonal shift, subtle border, top-to-bottom translucent highlight, inset top rim, and `--kpl-shadow-md`. Health changes may alter the semantic badge and border emphasis, but must not flood-fill the entire card.

## 3. Layout and Responsive Behavior

- Use the same content ceiling as the current control surface and mirror the shared system's intrinsic card-grid formula: equal `auto-fit` tracks with the published `o-grid--cards` minimum of `18rem`, capped by available width. This is browser layout mechanics, not a new token. The four cards naturally move from four to three, two, then one column without status-specific breakpoints.
- Keep the four cards in fixed source order. Do not use horizontal scrolling, a carousel, tabs, or a mobile court selector for primary content.
- Each card uses the existing vertical stack and wrapping action-cluster composition seen in `.operator-panel`, `.match-row`, and `.match-actions`. Use container queries for internal reflow, following the inspected shared match-card pattern without requiring its unloaded class.
- At narrow card widths, metadata wraps, desired/observed values stack, and action/link clusters become full-width rows. Labels remain visible; do not collapse to icon-only controls.
- Long event titles wrap; IDs and timestamps may truncate only when their full value is available by accessible name or adjacent detail. Primary state text never truncates.
- The document owns vertical scrolling. Cards do not create nested scroll regions. Preserve safe-area padding and prevent horizontal overflow at the existing 320px minimum.

### Setup Layout

- At wide widths, show a compact setup progress summary followed by a fixed-order four-court setup grid. Each court remains `pista-1` through `pista-4` in source and visual order.
- Each court setup card groups its fixed schedule, capture device assignment, shared agent assignment, and enabled program output. The active event-day and shared-principal fields appear once in a preceding shared-details panel, never repeated as four independent principals.
- On narrow widths, shared details stack before the four cards and each card becomes a single vertical form. Labels, selected values, validation messages, and status remain visible. Do not use a stepper that hides unfinished courts or a mobile court selector.
- Saving one valid unit must not reset completed units. A manager can leave and return to the overview, then re-enter setup to continue an incomplete configuration.

## 4. Primitives and Composition

The named overview pieces below are app-owned implementation units. They compose CSS that is already loaded by `global.css`; they are not claims that new shared components already exist and must not be promoted to `@kpl/design-system` as part of this work.

- **OverviewHeader:** the existing `.home-topbar` and `.brand`, with `.refresh-button` patterns for refresh and sign out and a text-labelled role badge derived from `.match-status`. Refresh shows loading without erasing the last good court data.
- **CourtGrid:** an app-local intrinsic grid, exactly four children, with no sorting or conditional removal.
- **CourtCard:** an `article` preserving the `.match-row`/`.operator-panel` compact radius, layered background, border, padding, and elevation using canonical token equivalents. The accessible name begins with the fixed court label. The card contains assignment, score/event context, status, lifecycle comparison, feedback, actions, links, and metadata.
- **StatusBadge:** the existing `.match-status`/`.connection-pill` anatomy plus Lucide icon and explicit text, remapped to canonical semantic tokens. Color and icon never carry meaning alone.
- **LifecycleComparison:** two labeled values, `Deseado` and `Observado`, using heading type and tabular values where applicable. A mismatch includes the text `Pendiente de reconciliación` and the latest observation time.
- **OperatorControls:** existing `.primary-action`, `.refresh-button`, button, and segmented-control patterns. The principal mutation is visually primary; reconcile is secondary; dangerous stopping/off actions use the existing danger treatment and confirmation when required. The selected lifecycle is the desired value, never the observed value.
- **CourtLinks:** retain `Mandos`/score-control at `/control/:courtSlug`, `OBS` at `/overlay/:courtSlug/scoreboard`, and `Publico` at `/live/:courtSlug`, using `.match-action`. Operators see all three; viewers see the read-only `OBS` and `Publico` destinations but not `Mandos`. Use the current Lucide `SlidersHorizontal`, `MonitorPlay`, and `Eye` vocabulary. Do not create a standalone `/score` route; the score/control surface remains the existing control route.
- **InlineFeedback:** extend the loaded `.loading-panel`, `.empty-panel`, and `.toast-error` anatomy with canonical status tokens. Initial loading preserves four card slots; persistent production truth stays in the card, never only in transient feedback.
- **SetupWorkspace:** an app-local manager-only composition within `/admin`, using the existing panel, form, action, status, modal, and toast anatomy. It has a shared-details panel for the active event day and agent principal, plus a `SetupCourtGrid` with exactly four fixed children.
- **SetupCourtCard:** one `article` per fixed court. It composes `FixedScheduleFields`, `CaptureAssignmentFields`, `AgentAssignmentSummary`, and `ProgramOutputFields`. The agent summary is read-only after selection because one principal serves every court.
- **LocalReferenceField:** a labelled text field for an externally supplied Auth UUID or redacted `local://` reference. It shows format guidance and inline validation without ever rendering a secret-value field, reveal control, clipboard history, or persisted draft containing secret material.
- **SetupProgress:** text-labelled count of complete and incomplete court records, plus the active event-day state. It is informative, not a substitute for each card's field-level error and recovery message.
- **SetupCompletion:** persistent success feedback after all four court configurations are accepted, with an explicit `Volver al resumen de producción` action. Returning reloads the authoritative overview and does not claim that a local agent, FFmpeg pipeline, or capture transport is already running.

Viewer cards omit `OperatorControls` and the `Mandos` link entirely. Their authorized `OBS` and `Publico` navigation is read-only and never implies a production mutation.

## 5. State Contract

Page-level states:

| State | Required presentation and behavior |
| --- | --- |
| Loading | On first load, show the page header and four position-preserving card skeletons. On refresh, retain last good data, mark refresh pending, and do not blank the grid. |
| Forbidden | Replace the grid with error-toned inline feedback: `No tienes permiso para ver producción.` Keep identity and sign out; offer no retry loop or controls unless authorization can actually change. |
| Transport error | Keep last good data if present, label it stale, show `No se pudo actualizar producción`, disable mutations, and provide retry. Without prior data, show page-level error feedback, not four fabricated failures. |
| Malformed-data error | Treat as an integrity error distinct from offline: `La respuesta de producción no es válida.` Preserve any last validated snapshot, disable mutations, and provide retry. Never partially trust an invalid payload. |

Setup states:

| State | Required presentation and behavior |
| --- | --- |
| Validation | Validate before each manager RPC: an active event day is present, the shared agent UUID is a UUID for an externally created Auth user, every court has its fixed schedule and one `local://` capture reference, and each event has one enabled local loopback SRT program output. Keep invalid values in their field, name the correction, and do not submit that unit. |
| Pending | Disable only the submitting shared panel or court card, retain all other accepted and editable setup data, show `Guardando configuración`, and prevent duplicate submission for that unit. Never clear a locally visible redacted reference while a request is pending. |
| Accepted | After an RPC accepts a created or updated event day, principal, device, schedule, assignment, output, or event status, mark that unit accepted and refresh its server version. Acceptance means the control-plane record was saved, not that media is active. |
| Malformed | For a malformed response, preserve the last validated accepted setup snapshot, label the affected unit `La respuesta de configuración no es válida`, block further submission for it, and offer refresh. Never infer which partial fields were saved. |
| Forbidden | Replace the workspace body with `No tienes permiso para configurar producción.` Preserve the top bar and return-to-overview action. Do not show setup fields, cached mutable values, or mutation controls. |
| Transport | On a network or RPC transport failure, retain unsaved non-secret field values only in the current page memory, retain accepted records, label the affected unit, and offer retry. Do not write setup drafts to browser storage. |
| Version conflict | When an expected-version conflict occurs, show `La configuración cambió en otro control`, preserve the entered non-secret values for comparison, block resubmission, refresh the authoritative unit, then require the manager to review and submit again. Never auto-replay. |
| Partial and resumable | An active event day with fewer than four accepted court configurations is incomplete. Show which fixed courts are incomplete, keep accepted courts intact, and let a manager resume only the missing or failed units later. The overview continues to show its ordinary no-assignment or current-assignment cards. |
| Complete and return | Completion requires the active event day, one shared agent principal assigned across all four courts, four local capture devices, four fixed schedules, four capture assignments, four agent assignments, four enabled local loopback SRT outputs, and the event records in their requested active state. Then offer return to the lifecycle overview and reload its authoritative data. |

Per-court states may coexist. Render exactly one primary observed-health badge (`Sin observación`, `Sin diagnóstico`, `Saludable`, `Degradado`, `Fallido`, or `Sin conexión`) and independent secondary badges/callouts for pending, mismatch, stale, conflict, and capacity deferral. This avoids collapsing runtime health and control-plane state into one ambiguous severity.

| State | Meaning | Card treatment |
| --- | --- | --- |
| No assignment | The fixed court has no active production assignment/output. | Neutral card, `Sin asignación`, no desired controls, no fabricated observed state; keep any route links that remain valid for that court. |
| No observation | No `ObservedOutputState` exists. This is not `offline`. | Neutral/info badge `Sin observación`; observed value is `No disponible`; show desired value and when it was requested. |
| Unknown | Observation exists with `health: unknown`. | Neutral badge `Sin diagnóstico`; show report time and observed lifecycle if supplied. |
| Healthy | `health: healthy`. | Success badge `Saludable`; when desired and observed agree, no warning treatment. |
| Degraded | `health: degraded`. | Warning badge `Degradado`; retain controls only when the operation policy permits recovery. |
| Failed | `health: failed`. | Danger badge `Fallido`; show the supplied failure summary and retry/reconcile only when allowed. |
| Offline | `health: offline`. | Danger badge `Sin conexión`; show last observation time. Do not present this as stopped successfully. |
| Pending | A desired-state/reconcile command was accepted and has not reached a terminal operation/observation outcome. | Info badge `Solicitud en curso`, disable duplicate/conflicting mutations, keep navigation enabled, and preserve the previous observed truth. |
| Desired/observed mismatch | Valid desired and observed lifecycles differ. | Warning callout `Pendiente de reconciliación`; show both values without replacing observed truth with intent. |
| Stale | Backend policy marks the snapshot/observation stale. | Warning badge `Datos desactualizados`, exact last report time, disabled mutations, and refresh. Do not invent a client-only timeout. |
| Conflict | Expected version or competing operation conflict. | Danger feedback `La pista cambió en otro control`; disable mutation until fresh data loads, then let the operator review before retrying. Never auto-replay. |
| Capacity-deferred | Desired lifecycle is active but admission capacity has deferred runtime start. | Warning badge `En espera de capacidad`; keep desired value unchanged, show observed truth, and do not classify it as failed or offline unless observation independently says so. |

Mutation policy is deterministic: disable all lifecycle/reconcile controls for forbidden, no-assignment, malformed-data, transport-error, stale, conflict, and pending states. Healthy, degraded, failed, offline, unknown, no-observation, mismatch, and capacity-deferred cards may expose only actions authorized by fresh server data; while capacity-deferred, suppress duplicate start/reconcile requests but retain stop/off recovery.

Acknowledgement is precise: after a successful command response, announce exactly `Solicitud de reconciliación aceptada` and enter pending. It means reconciliation was requested, not that FFmpeg, transport, overlay, or runtime startup succeeded. Announce success only when a subsequent authoritative operation result and/or observed state confirms the requested outcome. A failed operation exits pending and surfaces its supplied retryability and summary.

Setup save ordering is explicit and resumable: create or select the active event day, create the shared principal from the pre-created Auth UUID, create one local device per fixed court, save the four fixed schedules, save capture and shared-agent assignments, create one enabled local loopback SRT output per event, then request the active event status. The implementation uses the existing manager RPCs for those records, supplies their expected versions for updates, and refreshes authoritative data after every accepted operation. It must not fabricate a client-side transaction, infer runtime readiness, or bypass server validation.

Capacity remains a runtime concern after setup. One local agent serves exactly four courts, while at most three FFmpeg pipelines may run concurrently. The fourth active request may become `capacity-deferred`; setup completion does not reserve, start, or guarantee four concurrent pipelines.

## 6. Interaction, Keyboard, and Accessibility

- Target WCAG 2.2 AA: at least 4.5:1 for body text and 3:1 for large text and meaningful UI boundaries. Validate semantic status combinations against the dark surfaces.
- Use semantic `main`, heading hierarchy, `section`, and one `article` per court. Status updates use a restrained live region; initial data and routine polling must not repeatedly announce all four cards.
- DOM order defines keyboard order: top-bar actions, then each card from `pista-1` through `pista-4`, with controls before route links. No positive `tabindex` and no arrow-key grid trap.
- All actions are native buttons or links with visible text. Selected lifecycle uses `aria-pressed` or the shipped segmented-control semantics; pending uses disabled state plus visible explanatory copy. Disabled controls remain understandable from adjacent status text.
- Every interactive element uses the existing `--kpl-color-focus` focus-visible outline. Hover is supplementary, never the only disclosure or affordance. Touch targets use the existing `--kpl-control-size-md` minimum.
- Each status includes text and an icon in addition to color. Timestamps use a human-readable local value with the precise value available to assistive technology.
- Command acknowledgement and terminal failure are announced once. Focus remains on the invoking control unless a confirmation dialog opened; dialogs follow the shipped modal focus trap, Escape, return-focus, and labelled-title behavior.
- Motion is limited to existing fast/normal opacity or transform feedback. Under `prefers-reduced-motion: reduce`, remove card entrance, lift, shimmer, pulse, and status-transition motion; state changes remain immediate and textual.
- Support 200% zoom, reflow without primary horizontal scrolling, long Spanish labels, and browser text enlargement. Icons are decorative when adjacent text names the action.
- Setup fields use visible labels, required-state text, format examples that contain no credentials, and field-level errors linked with `aria-describedby`. The shared agent UUID and each `local://` reference must be readable and editable by keyboard without relying on placeholder text.
- Saving a setup unit announces its accepted, failed, malformed, or conflict outcome once. Focus stays on the invoking save action for inline outcomes; after completion, focus moves to the labelled completion heading and the return-to-overview action is next in order.
- A manager may return to the overview at any time. The return action never discards accepted records, and if current-page unsaved non-secret changes exist it uses the shipped confirmation dialog before leaving.

## 7. Acceptance Criteria

- `/admin` signed-out behavior is unchanged; signed-in viewer and operator views follow their capability boundaries.
- Exactly four court cards render in `pista-1` to `pista-4` order for every loading, assignment, and health combination.
- Desired intent and observed truth are simultaneously visible and never conflated; acknowledgement never claims immediate runtime success.
- Every page and court state in Section 5 has distinct, persistent, text-labelled treatment and a defined recovery path.
- The existing score/control, live, and overlay destinations remain available according to authorization; no route is redesigned.
- New visual rules use only the tokens and primitives listed here, preserve global ITCSS ordering, and keep app-specific composition in the app layer rather than the shared package.
- Keyboard-only review can reach every enabled action in logical order, identify focus, operate lifecycle choices, close confirmations, and understand pending/error outcomes without color or motion.
- At 320px and at wide production-monitor widths, the intrinsic grid reflows without card reordering, content loss, overlap, or primary horizontal scrolling.
- A manager can configure and resume the exact MVP shape: one active event day, one externally provisioned shared agent UUID assigned across four events, one `local://` capture device per court, four fixed schedules, capture and agent assignments, and one enabled local loopback SRT output per event.
- Invalid UUIDs and non-`local://` references never reach a setup RPC. Secrets never appear in setup fields, browser state, storage, telemetry, or logs.
- Setup explicitly distinguishes validation, pending, accepted, malformed, forbidden, transport, version-conflict, partial/resumable, and complete-return states, with server refresh before retry after a conflict or malformed response.
- Returning from setup restores the existing lifecycle overview and its fixed four-card semantics. Setup completion never represents media transport or all four pipelines as running.

## 8. Explicit Non-Goals and Debt

Excluded from this work: Auth-user creation; credential, token, or secret entry and handling; thumbnail or upload flows; asset generation; `media-config.json` generation or download; Android applications; YouTube integration; network-camera expansion; changes to score, control, live, overlay, admin-login, or application routing; new design-system tokens/components; copied brand assets; and dependency changes. The scoped manager workspace may create the stated production records only. It does not become general device, principal, Auth, asset, or media-runtime administration.

No visual or accessibility debt is pre-accepted by this contract. Any implementation exception must be recorded here with affected users, reason, owner, and exit condition before acceptance.
