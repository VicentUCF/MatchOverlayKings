import { Eye, LogOut, RefreshCw } from 'lucide-react';
import { useProductionOverview, type ProductionOverviewState } from '../hooks/useProductionOverview.js';
import { PRODUCTION_COURT_SLUGS, type ProductionOverviewAccess } from '../lib/production-overview-types.js';
import { ProductionCourtCard } from './ProductionCourtCard.js';

type ProductionOverviewProps = {
  readonly signOut: () => Promise<void>;
};

type ProductionOverviewViewProps = {
  readonly state: ProductionOverviewState;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
};

export function ProductionOverview({ signOut }: ProductionOverviewProps) {
  const overview = useProductionOverview();
  return <ProductionOverviewView state={overview.state} refresh={overview.refresh} signOut={signOut} />;
}

export function ProductionOverviewView({ state, refresh, signOut }: ProductionOverviewViewProps) {
  const capability = stateCapability(state);
  const refreshing = state.kind === 'refreshing';
  return (
    <main className="home-page production-overview-page">
      <header className="home-topbar production-overview-topbar">
        <div className="brand">
          <img src="/logos/kpl-wordmark.png" alt="" width="144" height="54" />
          <span><strong>KPL Admin</strong><small>Panel de producción</small></span>
        </div>
        <span className="production-role"><Eye aria-hidden="true" />{roleLabel(capability)}</span>
        <div className="production-topbar-actions">
          <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw aria-hidden="true" />{refreshing ? 'Actualizando' : 'Actualizar'}
          </button>
          <button type="button" className="refresh-button" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" />Salir
          </button>
        </div>
      </header>
      <section className="production-overview" aria-labelledby="production-overview-title">
        <header className="production-overview__heading">
          <div>
            <h1 id="production-overview-title">Producción · cuatro pistas</h1>
            <p>Estado operativo, contexto de marcador y solicitudes de reconciliación en una sola vista.</p>
          </div>
          {stateTimestamp(state)}
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
      {PRODUCTION_COURT_SLUGS.map((slug, index) => (
        <article className="production-court-card production-court-card--loading" data-court={slug} key={slug}>
          <span className="production-court-card__slug">{slug}</span>
          <h2>Pista {index + 1}</h2>
          <p>Cargando producción</p>
        </article>
      ))}
    </div>
  );
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

function roleLabel(capability: ProductionOverviewAccess['kind'] | null): string {
  switch (capability) {
    case 'operator': return 'Operador';
    case 'viewer': return 'Viewer';
    case null: return 'Verificando acceso';
    default: return assertNever(capability);
  }
}

function assertNever(value: never): never {
  void value;
  throw new TypeError('Unexpected production overview state');
}
