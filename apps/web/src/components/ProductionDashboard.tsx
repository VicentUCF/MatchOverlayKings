import {
  Activity,
  ExternalLink,
  MonitorPlay,
  Radio,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';
import type { PilotConfiguration, PilotCourtSlug, PilotSession } from '@kpl/production-contracts';
import { useProductionPilot, type PilotState } from '../hooks/useProductionPilot.js';
import { youtubeWatchUrl } from '../lib/pilot-youtube-watch.js';
import { ProductionNavigation } from './ProductionNavigation.js';

const COURTS = [
  { slug: 'pista-1', label: 'Pista 1' },
  { slug: 'pista-2', label: 'Pista 2' },
  { slug: 'pista-3', label: 'Pista 3' },
] as const satisfies readonly { readonly slug: PilotCourtSlug; readonly label: string }[];

type ProductionDashboardProps = {
  readonly signOut: () => Promise<void>;
  readonly onOpenConfiguration: () => void;
  readonly onOpenControls: () => void;
};

export function ProductionDashboard(props: ProductionDashboardProps) {
  const pilot = useProductionPilot();
  return <ProductionDashboardView state={pilot.state} refresh={pilot.refresh}
    localAdminUrl={pilot.localAdminUrl} {...props} />;
}

export function ProductionDashboardView({
  state,
  refresh = async () => undefined,
  signOut = async () => undefined,
  onOpenConfiguration = () => undefined,
  onOpenControls = () => undefined,
  localAdminUrl,
  embedded = false,
}: {
  readonly state: PilotState;
  readonly refresh?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
  readonly onOpenConfiguration?: () => void;
  readonly onOpenControls?: () => void;
  readonly localAdminUrl?: string;
  readonly embedded?: boolean;
}) {
  const configurations = state.kind === 'ready' ? state.configurations : [];
  const sessions = state.kind === 'ready' ? state.sessions : [];
  const configuredCount = COURTS.filter(({ slug }) => configurationFor(configurations, slug) !== null).length;
  const liveCount = COURTS.filter(({ slug }) => {
    const session = latestSession(sessions, slug);
    return session !== null && ['starting', 'live', 'stopping'].includes(session.status);
  }).length;

  const content = <>
    <section className="production-dashboard" aria-labelledby="production-dashboard-title">
      <header className="production-dashboard-heading">
        <div><p className="production-kicker">Jornada en directo</p><h1 id="production-dashboard-title">Las tres pistas, en un solo sitio</h1>
          <p>Comprueba qué se emite y qué aparece en pantalla antes de entrar a los controles.</p></div>
        <dl className="production-dashboard-summary">
          <div><dt>Configuradas</dt><dd>{configuredCount}/3</dd></div>
          <div><dt>Emitiendo</dt><dd>{liveCount}/3</dd></div>
          <div><dt>Agente</dt><dd>{state.kind === 'ready' ? 'Conectado' : 'Sin conexión'}</dd></div>
        </dl>
      </header>

      {state.kind === 'error' ? <div className="production-page-feedback danger" role="alert">
        <span>{state.message}</span>
        {localAdminUrl ? <a className="refresh-button" href={localAdminUrl}>Abrir panel local</a> : null}
        <button type="button" className="refresh-button" onClick={() => void refresh()}>Reintentar</button>
      </div> : null}
      {state.kind === 'ready' && state.error ? <div className="production-page-feedback danger" role="alert">{state.error}</div> : null}

      <section className="production-dashboard-courts" aria-label="Pistas de la jornada">
        {COURTS.map((court) => <UnifiedCourtCard key={court.slug} court={court}
          loading={state.kind === 'loading'} configuration={configurationFor(configurations, court.slug)}
          session={latestSession(sessions, court.slug)} onOpenConfiguration={onOpenConfiguration}
          onOpenControls={onOpenControls} />)}
      </section>
    </section>
  </>;

  if (embedded) return content;

  return <main className="home-page production-dashboard-page">
    <ProductionNavigation active="dashboard" role="admin" onRefresh={() => void refresh()}
      refreshing={state.kind === 'ready' && state.refreshing} onSignOut={() => void signOut()} />
    {content}
  </main>;
}

function UnifiedCourtCard({ court, configuration, session, loading, onOpenConfiguration, onOpenControls }: {
  readonly court: (typeof COURTS)[number];
  readonly configuration: PilotConfiguration | null;
  readonly session: PilotSession | null;
  readonly loading: boolean;
  readonly onOpenConfiguration: () => void;
  readonly onOpenControls: () => void;
}) {
  const status = streamStatus(session, loading);
  const watchUrl = youtubeWatchUrl(session);
  return <article className="production-dashboard-court" aria-labelledby={`dashboard-${court.slug}`}>
    <header><div><span className="production-court-card__slug">{court.slug}</span><h2 id={`dashboard-${court.slug}`}>{court.label}</h2></div>
      <span className={`production-status ${status.tone}`}><Activity aria-hidden="true" />{status.label}</span></header>
    <div className="production-dashboard-preview">
      <iframe src={`/overlay/${court.slug}/scoreboard`} title={`Vista previa del overlay de ${court.label}`} tabIndex={-1} />
      <span><MonitorPlay aria-hidden="true" />Vista previa del programa</span>
    </div>
    <div className="production-dashboard-court__body">
      {configuration === null ? <div className="production-dashboard-empty"><strong>Emisión sin configurar</strong>
        <p>Selecciona la fuente, los equipos y el destino antes de entregar los mandos.</p></div> : <>
        <div className="production-dashboard-match"><span>{configuration.mode === 'youtube' ? 'YouTube' : 'Simulación'}</span>
          <strong>{configuration.homeTeam} <small>vs</small> {configuration.awayTeam}</strong>
          <p>Jornada {configuration.matchdayNumber} · {privacyLabel(configuration.privacyStatus)}</p></div>
        {session?.encoder ? <dl className="production-dashboard-health">
          <div><dt>FPS</dt><dd>{session.encoder.framesPerSecond.toFixed(1)}</dd></div>
          <div><dt>Bitrate</dt><dd>{Math.round(session.encoder.bitrateKbps)} kb/s</dd></div>
          <div><dt>Velocidad</dt><dd>{session.encoder.speed.toFixed(2)}×</dd></div>
        </dl> : null}
      </>}
      <nav className="production-dashboard-court__actions" aria-label={`Controles de ${court.label}`}>
        {configuration === null
          ? <button type="button" className="refresh-button" onClick={onOpenConfiguration}><Settings2 aria-hidden="true" />Configurar emisión</button>
          : <button type="button" className="refresh-button" onClick={onOpenControls}><Radio aria-hidden="true" />Mandos de emisión</button>}
        <a className="refresh-button production-controls-entry" href={`/control/${court.slug}`}>
          <SlidersHorizontal aria-hidden="true" />Control visual
        </a>
        {watchUrl ? <a className="production-setup-submit production-dashboard-youtube-link" href={watchUrl}
          target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" />Ver directo en YouTube
        </a> : null}
      </nav>
    </div>
  </article>;
}

function configurationFor(configurations: readonly PilotConfiguration[], courtSlug: PilotCourtSlug): PilotConfiguration | null {
  return configurations.find((configuration) => configuration.courtSlug === courtSlug) ?? null;
}

function latestSession(sessions: readonly PilotSession[], courtSlug: PilotCourtSlug): PilotSession | null {
  return [...sessions].filter((session) => session.courtSlug === courtSlug).at(-1) ?? null;
}

function streamStatus(session: PilotSession | null, loading: boolean): { readonly label: string; readonly tone: string } {
  if (loading) return { label: 'Comprobando', tone: 'info' };
  if (session === null) return { label: 'Sin preparar', tone: 'neutral' };
  if (session.status === 'live') return { label: 'Emitiendo', tone: 'success' };
  if (session.status === 'starting') return { label: 'Iniciando', tone: 'info' };
  if (session.status === 'stopping') return { label: 'Deteniendo', tone: 'warning' };
  if (session.status === 'failed') return { label: 'Revisar', tone: 'danger' };
  if (session.status === 'prepared') return { label: 'Preparada', tone: 'info' };
  return { label: 'Finalizada', tone: 'neutral' };
}

function privacyLabel(privacy: PilotConfiguration['privacyStatus']): string {
  if (privacy === 'private') return 'Privado';
  if (privacy === 'unlisted') return 'No listado';
  return 'Público';
}
