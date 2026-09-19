import { useEffect, useState } from 'react';
import { useProductionOverview, type ProductionOverviewState } from '../hooks/useProductionOverview.js';
import { useProductionPilot, type ProductionPilotController } from '../hooks/useProductionPilot.js';
import type { ProductionCourtSlots, ProductionOverviewAccess } from '../lib/production-overview-types.js';
import { ProductionCourtCard } from './ProductionCourtCard.js';
import { ProductionDashboardView } from './ProductionDashboard.js';
import { ProductionPilotWorkspaceView } from './ProductionPilotWorkspace.js';
import { ProductionNavigation } from './ProductionNavigation.js';

export type ProductionDestination = 'dashboard' | 'emissions' | 'controls';
type AdminArea = ProductionDestination;

type ProductionOverviewProps = {
  readonly signOut: () => Promise<void>;
  readonly destination?: ProductionDestination;
};

type ProductionOverviewViewProps = {
  readonly state: ProductionOverviewState;
  readonly refresh?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
  readonly onOpenSetup?: () => void;
  readonly onOpenPilot?: () => void;
  readonly onOpenControls?: () => void;
  readonly onBack?: (() => void) | undefined;
};

export function ProductionOverview({ signOut, destination = 'dashboard' }: ProductionOverviewProps) {
  const overview = useProductionOverview();
  const pilot = useProductionPilot();
  const capability = stateCapability(overview.state);
  const courts = stateCourts(overview.state);
  const inventoryStale = overview.state.kind === 'stale';
  if (capability === 'operator') {
    return <ProductionPilotWorkspaceView pilot={pilot} initialView="controls" controlsOnly
      navigationRole="operator" onSignOut={signOut} courts={courts} inventoryStale={inventoryStale} />;
  }
  if (capability === 'admin') {
    return <ProductionTabbedWorkspace initialArea={destination} pilot={pilot} signOut={signOut} courts={courts}
      inventoryStale={inventoryStale} />;
  }
  if (capability === null) {
    return <ProductionAccessFeedback destination={destination} state={overview.state}
      refresh={overview.refresh} signOut={signOut} />;
  }
  return <ProductionOverviewView state={overview.state} refresh={overview.refresh} signOut={signOut} />;
}

function ProductionAccessFeedback({ destination, state, refresh, signOut }: {
  readonly destination: ProductionDestination;
  readonly state: ProductionOverviewState;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}) {
  const message = state.kind === 'forbidden' ? 'No tienes permiso para acceder al centro de producción.'
    : state.kind === 'error' ? 'No se pudo comprobar el acceso al centro de producción.'
      : 'Preparando el centro de producción…';
  return <main className="home-page production-overview-page">
    <ProductionNavigation active={destination} role="admin" onSignOut={() => void signOut()} />
    <div className={`production-page-feedback ${state.kind === 'loading' ? '' : 'danger'}`} role="status">
      <span>{message}</span>
      {state.kind === 'error' ? <button type="button" className="refresh-button" onClick={() => void refresh()}>Reintentar</button> : null}
    </div>
  </main>;
}

export function ProductionTabbedWorkspace({ initialArea, pilot, signOut, courts, inventoryStale = false }: {
  readonly initialArea: AdminArea;
  readonly pilot: ProductionPilotController;
  readonly signOut: () => Promise<void>;
  readonly courts: ProductionCourtSlots;
  readonly inventoryStale?: boolean;
}) {
  const [activeArea, setActiveArea] = useState<AdminArea>(initialArea);
  const [selectedCourt, setSelectedCourt] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('pista'));

  useEffect(() => {
    const syncFromHistory = () => {
      setActiveArea(areaFromPath(window.location.pathname));
      setSelectedCourt(new URLSearchParams(window.location.search).get('pista'));
    };
    window.addEventListener('popstate', syncFromHistory);
    return () => window.removeEventListener('popstate', syncFromHistory);
  }, []);

  const openArea = (area: AdminArea) => {
    if (area === activeArea && !(area === 'dashboard' && selectedCourt)) return;
    window.history.pushState({}, '', pathForArea(area));
    setActiveArea(area);
    if (area === 'dashboard') setSelectedCourt(null);
  };
  const selectCourt = (slug: string | null) => {
    window.history.pushState({}, '', slug ? `/admin?pista=${encodeURIComponent(slug)}` : '/admin');
    setSelectedCourt(slug);
  };

  return <main className="home-page production-overview-page production-tabbed-workspace">
    <ProductionNavigation active={activeArea} role="admin" onAreaChange={openArea}
      onRefresh={() => void pilot.refresh()} refreshing={pilot.state.kind === 'ready' && pilot.state.refreshing}
      onSignOut={() => void signOut()} />
    {inventoryStale ? <InventoryStaleWarning /> : null}
    <section id="production-panel-dashboard" className="production-workspace-panel" role="tabpanel"
      aria-labelledby="production-tab-dashboard" hidden={activeArea !== 'dashboard'} tabIndex={0}>
      <ProductionDashboardView state={pilot.state} pilot={pilot} refresh={pilot.refresh} localAdminUrl={pilot.localAdminUrl} embedded
        selectedCourt={selectedCourt} onSelectCourt={selectCourt} monitoringActive={activeArea === 'dashboard'}
        courts={courts} onOpenConfiguration={() => openArea('emissions')} onOpenControls={() => openArea('controls')} />
    </section>
    <section id="production-panel-emissions" className="production-workspace-panel" role="tabpanel"
      aria-labelledby="production-tab-emissions" hidden={activeArea !== 'emissions'} tabIndex={0}>
      <ProductionPilotWorkspaceView pilot={pilot} initialView="configuration" embedded
        courts={courts} onOpenControls={() => openArea('controls')} />
    </section>
    <section id="production-panel-controls" className="production-workspace-panel" role="tabpanel"
      aria-labelledby="production-tab-controls" hidden={activeArea !== 'controls'} tabIndex={0}>
      <ProductionPilotWorkspaceView pilot={pilot} initialView="controls" controlsOnly embedded courts={courts}
        monitoringActive={activeArea === 'controls'} />
    </section>
  </main>;
}

function InventoryStaleWarning() {
  return <div className="production-page-feedback danger" role="status">
    No se pudo actualizar el inventario de Supabase. Se conserva la última configuración válida;
    revisa las pistas antes de iniciar una emisión.
  </div>;
}

function pathForArea(area: AdminArea): string {
  if (area === 'emissions') return '/admin/emisiones';
  if (area === 'controls') return '/mandos';
  return '/admin';
}

function areaFromPath(path: string): AdminArea {
  if (path === '/admin/emisiones') return 'emissions';
  if (path === '/mandos') return 'controls';
  return 'dashboard';
}

export function ProductionOverviewView({
  state,
  refresh = async () => undefined,
  signOut = async () => undefined,
  onOpenSetup,
}: ProductionOverviewViewProps) {
  const capability = stateCapability(state);
  const refreshing = state.kind === 'refreshing';
  return (
    <main className="home-page production-overview-page">
      <ProductionNavigation active="system" role={capability ?? 'admin'}
        onRefresh={() => void refresh()} refreshing={refreshing} onSignOut={() => void signOut()} />
      <section className="production-overview" aria-labelledby="production-overview-title">
        <header className="production-overview__heading">
          <div>
            <h1 id="production-overview-title">Sistema de producción</h1>
            <p>Diagnóstico técnico, estado deseado y reconciliación de los agentes.</p>
          </div>
          <div className="production-overview__heading-actions">
            {capability === 'admin' && onOpenSetup !== undefined ? (
              <button type="button" className="refresh-button production-setup-entry" onClick={onOpenSetup}>
                Configuración técnica
              </button>
            ) : null}
            {stateTimestamp(state)}
          </div>
        </header>
        {renderOverviewState(state, refresh)}
      </section>
    </main>
  );
}

function renderOverviewState(state: ProductionOverviewState, refresh: () => Promise<void>) {
  switch (state.kind) {
    case 'loading': return <LoadingGrid />;
    case 'ready': return <CourtGrid access={state.access} stale={false} refresh={refresh} />;
    case 'refreshing': return (
      <CourtGrid access={state.access} stale refresh={refresh} />
    );
    case 'stale': return (
      <>
        <OverviewFeedback kind={state.error.kind} retry={refresh} />
        <CourtGrid access={state.access} stale refresh={refresh} />
      </>
    );
    case 'forbidden': return <div className="production-page-feedback danger">No tienes permiso para ver producción.</div>;
    case 'error': return <OverviewFeedback kind={state.error.kind} retry={refresh} />;
    default: return assertNever(state);
  }
}

function CourtGrid({ access, stale, refresh }: {
  readonly access: ProductionOverviewAccess;
  readonly stale: boolean;
  readonly refresh: () => Promise<void>;
}) {
  return (
    <div className="production-court-grid">
      {access.snapshot.courts.map((court) => (
        <ProductionCourtCard key={court.slug} court={court} access={access} capability={access.kind} stale={stale} refresh={refresh} />
      ))}
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="production-court-grid" aria-busy="true">
      <article className="production-court-card production-court-card--loading">
        <span className="production-court-card__slug">Inventario</span>
        <h2>Cargando pistas</h2>
        <p>Consultando la configuración autoritativa</p>
      </article>
    </div>
  );
}

function stateCourts(state: ProductionOverviewState): ProductionCourtSlots {
  switch (state.kind) {
    case 'ready':
    case 'refreshing':
    case 'stale': return state.access.snapshot.courts;
    case 'loading':
    case 'forbidden':
    case 'error': return [];
    default: return assertNever(state);
  }
}

function OverviewFeedback({ kind, retry }: {
  readonly kind: 'malformed' | 'transport';
  readonly retry: () => Promise<void>;
}) {
  return (
    <div className="production-page-feedback danger">
      <span>{kind === 'malformed' ? 'La respuesta de producción no es válida.' : 'No se pudo actualizar producción.'}</span>
      <button type="button" className="refresh-button" onClick={() => void retry()}>Reintentar</button>
    </div>
  );
}

function stateCapability(state: ProductionOverviewState): ProductionOverviewAccess['kind'] | null {
  switch (state.kind) {
    case 'ready':
    case 'refreshing':
    case 'stale': return state.access.kind;
    case 'loading':
    case 'forbidden':
    case 'error': return null;
    default: return assertNever(state);
  }
}

function stateTimestamp(state: ProductionOverviewState) {
  switch (state.kind) {
    case 'ready':
    case 'refreshing':
    case 'stale': return <RefreshTimestamp value={state.access.snapshot.loadedAt} />;
    case 'loading': return <span className="production-refresh-time">Esperando primera actualización</span>;
    case 'forbidden':
    case 'error': return null;
    default: return assertNever(state);
  }
}

function RefreshTimestamp({ value }: { readonly value: string }) {
  return (
    <span className="production-refresh-time">
      Última actualización <time dateTime={value} aria-label={value}>{new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))}</time>
    </span>
  );
}

function assertNever(value: never): never {
  void value;
  throw new TypeError('Unexpected production overview state');
}
