import { useEffect, useRef } from 'react';
import { Activity, ArrowLeft, ExternalLink, Radio, Settings2 } from 'lucide-react';
import type { PilotConfiguration, PilotCourtSlug, PilotSession } from '@kpl/production-contracts';
import { useProductionPilot, type PilotState, type ProductionPilotController } from '../hooks/useProductionPilot.js';
import { youtubeWatchUrl } from '../lib/pilot-youtube-watch.js';
import type { ProductionCourtSlot } from '../lib/production-overview-types.js';
import { ProductionNavigation } from './ProductionNavigation.js';
import { PilotControlPanel } from './ProductionPilotWorkspace.js';
import { PilotOperationHistory } from './PilotOperationHistory.js';
import {
  CourtCameraMonitor, CourtOverlayMonitor, CourtScoreMonitor, ScorerAccess, sessionIssues, useMonitorClock,
} from './ProductionCourtMonitor.js';

type ProductionDashboardProps = {
  readonly courts: readonly ProductionCourtSlot[];
  readonly signOut: () => Promise<void>;
  readonly onOpenConfiguration: () => void;
  readonly onOpenControls: () => void;
};

export function ProductionDashboard(props: ProductionDashboardProps) {
  const pilot = useProductionPilot();
  return <ProductionDashboardView state={pilot.state} pilot={pilot} refresh={pilot.refresh}
    localAdminUrl={pilot.localAdminUrl} {...props} />;
}

export function ProductionDashboardView({
  state, refresh = async () => undefined, signOut = async () => undefined,
  onOpenConfiguration = () => undefined, onOpenControls = () => undefined,
  localAdminUrl, embedded = false, courts, pilot, selectedCourt = null,
  onSelectCourt, monitoringActive = true,
}: {
  readonly state: PilotState;
  readonly refresh?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
  readonly onOpenConfiguration?: () => void;
  readonly onOpenControls?: () => void;
  readonly localAdminUrl?: string;
  readonly embedded?: boolean;
  readonly courts: readonly ProductionCourtSlot[];
  readonly pilot?: ProductionPilotController;
  readonly selectedCourt?: string | null;
  readonly onSelectCourt?: (slug: string | null) => void;
  readonly monitoringActive?: boolean;
}) {
  const now = useMonitorClock();
  const previousSelection = useRef(selectedCourt);
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selectedCourt;
    if (previous === selectedCourt) return;
    const target = selectedCourt ? document.getElementById('production-detail-title')
      : document.getElementById(`production-open-${previous}`);
    target?.focus();
  }, [selectedCourt]);
  const enabled = courts.filter(({ productionEnabled }) => productionEnabled);
  const ready = state.kind === 'ready' ? state : null;
  const configurations = ready?.configurations ?? [];
  const sessions = ready?.sessions ?? [];
  const stale = state.kind === 'error' || Boolean(ready?.error)
    || (ready?.confirmedAt !== undefined && now - ready.confirmedAt > 15_000);
  const liveCount = enabled.filter(({ slug }) => latestSession(sessions, slug)?.status === 'live').length;
  const issues = enabled.flatMap((court) => sessionIssues(latestSession(sessions, court.slug)).map((message) => ({ court, message })));
  const incidentCount = new Set(issues.map(({ court }) => court.slug)).size;
  const court = courts.find(({ slug }) => slug === selectedCourt) ?? null;
  const select = (slug: string | null) => onSelectCourt ? onSelectCourt(slug) : onOpenControls();
  const configuration = court ? configurationFor(configurations, court.slug) : null;
  const session = court ? latestSession(sessions, court.slug) : null;
  const mobileCamera = court ? ready?.mobileCameras.find(({ courtSlug }) => courtSlug === court.slug) ?? null : null;
  const watchUrl = youtubeWatchUrl(session);

  const feedback = <>
    {stale ? <div className="production-page-feedback danger" role="alert">
      <strong>Datos de emisión sin confirmar</strong>
      <span>{state.kind === 'error' ? state.message : ready?.error ?? 'No se han recibido datos recientes del PC de emisión.'}
        {' '}Los valores conservados no confirman que el directo siga activo.</span>
      <button type="button" className="refresh-button" onClick={() => void refresh()}>Reintentar conexión</button>
      {localAdminUrl ? <a className="refresh-button" href={localAdminUrl}>Abrir panel local</a> : null}
    </div> : null}
  </>;
  const content = <section className="production-dashboard" aria-labelledby={court ? 'production-detail-title' : 'production-dashboard-title'}>
    {court ? <>
      <div className="production-detail-navigation">
        <button type="button" className="refresh-button" onClick={() => select(null)}><ArrowLeft aria-hidden="true" />Todas las pistas</button>
        <label>Cambiar de pista <select value={court.slug} onChange={(event) => select(event.currentTarget.value)}>
          {courts.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
        </select></label>
      </div>
      <header className="production-dashboard-heading">
        <div><p className="production-kicker">Realización · Vista individual</p><h1 id="production-detail-title" tabIndex={-1}>{court.name}</h1>
          <p>{configuration ? `${configuration.homeTeam} vs ${configuration.awayTeam}` : 'Pista pendiente de configurar'} · El anotador controla el tanteo desde su dispositivo.</p></div>
        <span className={`production-status ${stale ? 'warning' : streamStatus(session, state.kind === 'loading', court.productionEnabled).tone}`}>
          {stale ? 'Estado sin confirmar' : streamStatus(session, state.kind === 'loading', court.productionEnabled).label}</span>
      </header>
      {feedback}
      <div className="production-detail-layout">
        <div className="production-detail-monitors">
          {monitoringActive ? <>
            <CourtScoreMonitor key={court.slug} courtSlug={court.slug} configuration={configuration} now={now} />
            <CourtCameraMonitor courtSlug={court.slug} mobileCamera={mobileCamera} source={session?.source.id ?? configuration?.sourceId} detailed />
            <CourtOverlayMonitor key={`overlay-${court.slug}`} courtSlug={court.slug} />
          </> : null}
          <ScorerAccess key={`scorer-${court.slug}`} courtSlug={court.slug} />
        </div>
        <aside className="production-detail-controls" aria-label={`Realización de ${court.name}`}>
          <section className="production-output-monitor">
            <h2>Salida y audio</h2>
            <dl className="production-dashboard-health">
              <div><dt>Destino</dt><dd>{session?.mode === 'youtube' ? 'YouTube' : configuration?.mode === 'simulation' ? 'Simulación' : 'Sin preparar'}</dd></div>
              <div><dt>En emisión</dt><dd>{duration(session, now)}</dd></div>
              <div><dt>Audio de cámara</dt><dd>{session?.continuity?.active ? 'Silenciado en continuidad'
                : mobileCamera?.applied ? mobileCamera.applied.audioEnabled ? 'Activado' : 'Desactivado'
                  : session?.signal ? session.signal.audioExpected ? 'Se espera audio' : 'Sin micrófono' : 'Sin confirmar'}</dd></div>
            </dl>
            <p>Salud de YouTube: <strong>{stale ? 'Sin confirmar' : session?.youtubeStreamStatus ?? 'Sin datos del destino'}</strong></p>
            {configuration ? <p>Visibilidad configurada: <strong>{privacyLabel(configuration.privacyStatus)}</strong></p> : null}
            {watchUrl ? <a className="production-setup-submit" href={watchUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />Comprobar salida en YouTube</a> : <p>El enlace al directo aparecerá cuando la sesión permita comprobarlo.</p>}
            <p className="production-monitor-note">YouTube tiene retardo. Comprueba allí el vídeo final, el marcador y el audio que recibe el público.</p>
          </section>
          {ready && pilot ? <PilotControlPanel key={court.slug} court={court} configuration={configuration} session={session}
            pending={ready.pendingCourts.includes(court.slug)} error={ready.courtErrors[court.slug] ?? null}
            mobileCamera={mobileCamera} showMobileMonitor={false} showVisualLink={false} idPrefix="detail-control"
            onPrepare={(input) => void pilot.prepare(input)} onStart={(value) => void pilot.start(value)}
            onRecover={(value) => void pilot.recover(value)} onStop={(value) => void pilot.stop(value)}
            onElapsed={() => undefined} preflight={pilot} /> : null}
          {!configuration && state.kind === 'ready' ? <button type="button" className="refresh-button" onClick={onOpenConfiguration}>
            <Settings2 aria-hidden="true" />Configurar emisión</button> : null}
          <PilotOperationHistory key={`history-${court.slug}`} initialCourt={court.slug} />
        </aside>
      </div>
    </> : <>
      <header className="production-dashboard-heading">
        <div><p className="production-kicker">Realización · Vista global</p><h1 id="production-dashboard-title">Todas las pistas, en un solo sitio</h1>
          <p>Supervisa la señal y los marcadores de los anotadores. Abre una pista para controlar su emisión.</p></div>
        <dl className="production-dashboard-summary">
          <div><dt>Emitiendo</dt><dd>{stale || !ready ? '—' : `${liveCount}/${enabled.length}`}</dd></div>
          <div><dt>Con incidencias</dt><dd>{stale || !ready ? '—' : incidentCount}</dd></div>
          <div><dt>PC de emisión</dt><dd>{stale ? 'Sin confirmar' : ready ? 'Conectado' : 'Comprobando'}</dd></div>
        </dl>
      </header>
      {feedback}
      {selectedCourt ? <p role="status">La pista solicitada no está en el inventario. Selecciona una de las pistas disponibles.</p> : null}
      {issues.length > 0 ? <section className="production-monitor-incidents" aria-label="Pistas que requieren atención">
        <h2>{stale ? 'Últimas incidencias conocidas' : 'Requieren atención'}</h2>
        <ul>{enabled.filter((item) => issues.some(({ court: affected }) => affected.slug === item.slug)).map((item) => <li key={item.slug}>
          <button type="button" className="refresh-button" onClick={() => select(item.slug)}>{item.name}</button>
          <span>{issues.find(({ court: affected }) => affected.slug === item.slug)?.message}</span>
        </li>)}</ul>
      </section> : null}
      {courts.length === 0 ? <p className="production-page-feedback" role="status">No hay pistas disponibles para supervisar.</p> : null}
      <section className="production-dashboard-courts" aria-label="Pistas de la jornada">
        {courts.map((item) => {
          const config = configurationFor(configurations, item.slug);
          const current = latestSession(sessions, item.slug);
          const status = streamStatus(current, state.kind === 'loading', item.productionEnabled);
          const url = youtubeWatchUrl(current);
          return <article key={item.slug} className="production-dashboard-court" aria-labelledby={`dashboard-${item.slug}`}>
            <header><div><span className="production-court-card__slug">{item.slug}</span><h2 id={`dashboard-${item.slug}`}>{item.name}</h2></div>
              <span className={`production-status ${stale ? 'warning' : status.tone}`}><Activity aria-hidden="true" />{stale ? 'Sin confirmar' : status.label}</span></header>
            {monitoringActive ? <CourtCameraMonitor courtSlug={item.slug} mobileCamera={ready?.mobileCameras.find(({ courtSlug }) => courtSlug === item.slug) ?? null}
              source={current?.source.id ?? config?.sourceId} /> : null}
            <div className="production-dashboard-court__body">
              {monitoringActive ? <CourtScoreMonitor key={item.slug} courtSlug={item.slug} configuration={config} now={now} /> : null}
              {!item.productionEnabled ? <p>Producción desactivada. El marcador sigue disponible.</p>
                : !config ? <div className="production-dashboard-empty"><strong>{state.kind === 'ready' ? 'Emisión sin configurar' : 'Configuración sin confirmar'}</strong></div>
                  : <div className="production-dashboard-match"><span>{config.mode === 'youtube' ? 'YouTube' : 'Simulación'} · {privacyLabel(config.privacyStatus)}</span>
                    <p>Jornada {config.matchdayNumber} · {duration(current, now)}</p></div>}
              {current?.encoder && current.status !== 'stopped' ? <dl className="production-dashboard-health" aria-label={stale ? 'Últimas métricas conocidas' : 'Métricas de emisión'}>
                <div><dt>FPS</dt><dd>{current.encoder.framesPerSecond.toFixed(1)}</dd></div>
                <div><dt>Bitrate</dt><dd>{Math.round(current.encoder.bitrateKbps)} kb/s</dd></div>
                <div><dt>Velocidad</dt><dd>{current.encoder.speed.toFixed(2)}×</dd></div>
              </dl> : null}
              {current?.videoEncoding ? <p className="production-monitor-note">Codificación: {current.videoEncoding.label}</p> : null}
              {sessionIssues(current).length > 0 ? <p className="production-command-feedback warning">{sessionIssues(current)[0]}</p> : null}
              <nav className="production-dashboard-court__actions" aria-label={`Supervisión de ${item.name}`}>
                <button type="button" className="production-setup-submit" id={`production-open-${item.slug}`} data-monitor-court={item.slug} onClick={() => select(item.slug)}>
                  <Radio aria-hidden="true" />Abrir pista</button>
                {!config && ready ? <button type="button" className="refresh-button" onClick={onOpenConfiguration}><Settings2 aria-hidden="true" />Configurar emisión</button> : null}
                {url ? <a className="refresh-button" href={url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />Ver directo en YouTube</a> : null}
              </nav>
            </div>
          </article>;
        })}
      </section>
      <p className="production-monitor-note">Marcadores por Realtime con comprobación cada 5 s. Emisiones activas: actualización cada 2 s.
        {ready?.confirmedAt ? ` Última confirmación del PC: ${new Date(ready.confirmedAt).toLocaleTimeString('es-ES')}.` : ''}</p>
    </>}
  </section>;
  if (embedded) return content;
  return <main className="home-page production-dashboard-page">
    <ProductionNavigation active="dashboard" role="admin" onRefresh={() => void refresh()}
      refreshing={ready?.refreshing ?? false} onSignOut={() => void signOut()} />
    {content}
  </main>;
}

function configurationFor(configurations: readonly PilotConfiguration[], courtSlug: PilotCourtSlug): PilotConfiguration | null {
  return configurations.find((configuration) => configuration.courtSlug === courtSlug) ?? null;
}
function latestSession(sessions: readonly PilotSession[], courtSlug: PilotCourtSlug): PilotSession | null {
  return [...sessions].filter((session) => session.courtSlug === courtSlug).at(-1) ?? null;
}
export function streamStatus(session: PilotSession | null, loading: boolean, enabled: boolean): { readonly label: string; readonly tone: string } {
  if (!enabled) return { label: 'Desactivada', tone: 'warning' };
  if (loading) return { label: 'Comprobando', tone: 'info' };
  if (session === null) return { label: 'Sin preparar', tone: 'neutral' };
  if (session.status === 'stopped') return { label: 'Finalizada', tone: 'neutral' };
  if (session.continuity?.active) return { label: 'Continuidad · Revisar cámara', tone: 'warning' };
  if (session.overlayHealth && session.overlayHealth.status !== 'ready') return { label: 'Revisar marcador', tone: 'warning' };
  if (session.status === 'live' && sessionIssues(session).length > 0) return { label: 'Emitiendo · Revisar señal', tone: 'warning' };
  if (session.status === 'live') return { label: 'Emitiendo', tone: 'success' };
  if (session.status === 'starting') return { label: 'Iniciando', tone: 'info' };
  if (session.status === 'stopping') return { label: 'Deteniendo', tone: 'warning' };
  if (session.status === 'reconnecting') return { label: 'Recuperando', tone: 'warning' };
  if (session.status === 'interrupted') return { label: 'Interrumpida', tone: 'danger' };
  if (session.status === 'failed') return { label: 'Revisar', tone: 'danger' };
  if (session.status === 'preparing') return { label: 'Preparando destino', tone: 'info' };
  return { label: 'Preparada', tone: 'info' };
}
function privacyLabel(privacy: PilotConfiguration['privacyStatus']): string {
  return privacy === 'private' ? 'Privado' : privacy === 'unlisted' ? 'No listado' : 'Público';
}
function duration(session: PilotSession | null, now: number): string {
  if (!session?.startedAt || session.status === 'stopped') return '—';
  const seconds = Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 1_000));
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
