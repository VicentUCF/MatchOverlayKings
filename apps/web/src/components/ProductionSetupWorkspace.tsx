import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { useProductionSetup } from '../hooks/useProductionSetup.js';
import { deriveProductionSetupCompletion } from '../lib/production-setup-orchestrator.js';
import type { ProductionSetupWorkspaceState, SetupCourtDraft } from '../lib/production-setup-types.js';
import { ProductionSetupCourtCard } from './ProductionSetupCourtCard.js';
import { ProductionNavigation } from './ProductionNavigation.js';

type SharedDraftField = 'eventDayName' | 'eventDate' | 'timeZone' | 'agentAuthUserId';
type CourtDraftField = 'captureAuthUserId' | 'captureRef' | 'outputRef' | 'title'
  | 'scheduledStartAt' | 'scheduledEndAt';
type ProductionSetupWorkspaceViewProps = {
  readonly state: ProductionSetupWorkspaceState;
  readonly onBack?: () => void;
  readonly onSharedChange?: (field: SharedDraftField, value: string) => void;
  readonly onCourtChange?: (slug: SetupCourtDraft['slug'], field: CourtDraftField, value: string) => void;
  readonly onRefresh?: () => void;
  readonly onSubmit?: () => void;
  readonly signOut?: () => Promise<void>;
};

const MESSAGE = {
  validation: 'Revisa los datos indicados. No se ha completado la configuración.',
  forbidden: 'No tienes permiso para configurar producción.',
  conflict: 'La configuración cambió en otro control. Revisa los datos actualizados antes de continuar.',
  malformed: 'La respuesta de configuración no es válida. Actualiza el inventario antes de continuar.',
  transport: 'No se pudo contactar con el servidor. Se ha conservado el progreso aceptado.',
  pending: 'Guardando configuración…',
  accepted: 'Progreso aceptado por el servidor.',
} as const;

export function ProductionSetupWorkspace({
  clubId, onBack, signOut,
}: { readonly clubId: string; readonly onBack: () => void; readonly signOut: () => Promise<void> }) {
  const controller = useProductionSetup(clubId);
  const requestBack = () => {
    const incompleteChanges = controller.state.kind === 'ready' && controller.state.dirty
      && !deriveProductionSetupCompletion(controller.state.inventory, controller.state.draft).complete;
    if (incompleteChanges && !window.confirm('Hay cambios sin aceptar. ¿Volver al resumen de producción?')) return;
    onBack();
  };
  return <ProductionSetupWorkspaceView state={controller.state} onBack={requestBack} signOut={signOut}
    onSharedChange={controller.updateShared} onCourtChange={controller.updateCourt}
    onRefresh={() => { void controller.refresh(); }}
    onSubmit={() => { void controller.submit(); }} />;
}

export function ProductionSetupWorkspaceView({
  state, onBack = () => undefined, onSharedChange = () => undefined,
  onCourtChange = () => undefined, onRefresh = () => undefined,
  onSubmit = () => undefined, signOut,
}: ProductionSetupWorkspaceViewProps) {
  if (state.kind === 'loading') return <SetupShell onBack={onBack} signOut={signOut}><p>Cargando inventario seguro…</p></SetupShell>;
  if (state.kind === 'forbidden') return <SetupShell onBack={onBack} signOut={signOut}><p role="alert">{MESSAGE.forbidden}</p></SetupShell>;
  if (state.kind === 'error') return (
    <SetupShell onBack={onBack} signOut={signOut}>
      <div className="production-page-feedback danger">
        <p role="alert">{MESSAGE[state.error]}</p>
        <button type="button" onClick={onRefresh}>Reintentar inventario</button>
      </div>
    </SetupShell>
  );

  const completion = deriveProductionSetupCompletion(state.inventory, state.draft);
  const pending = state.progress?.kind === 'pending';
  const blocked = state.progress?.kind === 'conflict' || state.progress?.kind === 'malformed';
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(); };
  return (
    <SetupShell onBack={onBack} signOut={signOut}>
      <form className="production-setup" onSubmit={handleSubmit}>
        <section className="production-setup-shared" aria-labelledby="setup-shared-title">
          <div className="production-setup-shared__heading">
            <div><p className="production-setup-court__eyebrow">Compartido</p><h2 id="setup-shared-title">Jornada y agente local</h2></div>
            <strong>{completion.completeCourts}/{state.draft.courts.length} pistas preparadas</strong>
          </div>
          <div className="production-setup-fields production-setup-fields--shared">
            <label htmlFor="setup-day-name">Nombre de la jornada</label>
            <input id="setup-day-name" value={state.draft.eventDayName} onChange={(event) => onSharedChange('eventDayName', event.currentTarget.value)} required />
            <label htmlFor="setup-event-date">Fecha</label>
            <input id="setup-event-date" type="date" value={state.draft.eventDate} onChange={(event) => onSharedChange('eventDate', event.currentTarget.value)} required />
            <label htmlFor="setup-time-zone">Zona horaria</label>
            <input id="setup-time-zone" value={state.draft.timeZone} onChange={(event) => onSharedChange('timeZone', event.currentTarget.value)} required />
            <label htmlFor="setup-agent-auth">Auth UUID del agente</label>
            <input id="setup-agent-auth" name="agentAuthUserId" aria-label="Auth UUID del agente"
              aria-describedby="agent-auth-help" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
              value={state.draft.agentAuthUserId}
              onChange={(event) => onSharedChange('agentAuthUserId', event.currentTarget.value)} required />
            <small id="agent-auth-help">Obligatorio. Formato UUID del usuario Auth pre-creado para el agente compartido.</small>
          </div>
        </section>
        <div className="production-setup-courts">
          {state.draft.courts.map((court) => <ProductionSetupCourtCard key={court.slug} court={court}
            complete={completion.courts.find(({ slug }) => slug === court.slug)?.complete ?? false}
            captureConfigured={state.inventory.devices.some(({ id, enabled }) => id === court.deviceId && enabled)}
            outputConfigured={state.inventory.outputs.some(({ id, enabled }) => id === court.outputId && enabled)}
            agentAuthUserId={state.draft.agentAuthUserId}
            onChange={onCourtChange} />)}
        </div>
        <aside className="production-capacity-note">
          Capacidad operativa: la plataforma admite tres canalizaciones concurrentes. Coordina los directos para evitar solapamientos.
        </aside>
        {completion.complete ? <SetupCompletion onBack={onBack} /> : (
          <div className="production-setup-actions">
            <p className="production-setup-feedback" role="status" aria-live="polite">
              {state.progress === null ? 'Los cambios se aplican en orden y pueden reanudarse.' : MESSAGE[state.progress.kind]}
            </p>
            {blocked ? <button className="refresh-button" type="button" onClick={onRefresh}>Actualizar inventario</button> : null}
            <button className="production-setup-submit" type="submit" disabled={pending || blocked}>
              {pending ? 'Guardando…' : 'Guardar y configurar'}
            </button>
          </div>
        )}
      </form>
    </SetupShell>
  );
}

function SetupCompletion({ onBack }: { readonly onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <section className="production-setup-completion" aria-labelledby="setup-completion-title">
      <div><h2 id="setup-completion-title" ref={heading} tabIndex={-1}>Configuración completada</h2>
        <p>Los registros de control están aceptados. Esto no confirma que las canalizaciones estén ejecutándose.</p></div>
      <button className="production-setup-submit" type="button" onClick={onBack}>Volver al resumen de producción</button>
    </section>
  );
}

function SetupShell({
  children, onBack, signOut,
}: { readonly children: ReactNode; readonly onBack: () => void; readonly signOut: (() => Promise<void>) | undefined }) {
  return (
    <main className="home-page production-overview-page production-setup-page">
      <ProductionNavigation active="system" role="admin"
        onSignOut={signOut ? () => void signOut() : undefined} />
      <header className="production-setup-titlebar">
        <div><p className="production-kicker">Sistema · Configuración técnica</p><h1>Configurar producción</h1></div>
        <button className="refresh-button" type="button" onClick={onBack}>Volver a Sistema</button>
      </header>
      {children}
    </main>
  );
}
