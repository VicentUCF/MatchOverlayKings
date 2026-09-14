import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CircleCheck, CircleX, ExternalLink, MonitorPlay, Radio, RefreshCw,
  Settings2, SlidersHorizontal, TestTube2,
} from 'lucide-react';
import type {
  PilotConfiguration, PilotCourtSlug, PilotMode, PilotPrivacy, PilotReadiness,
  PilotSession, PreparePilotSessionInput,
} from '@kpl/production-contracts';
import { useProductionPilot, type ProductionPilotController } from '../hooks/useProductionPilot.js';
import { ProductionNavigation, type ProductionNavigationRole } from './ProductionNavigation.js';

const COURTS: readonly {
  readonly slug: PilotCourtSlug;
  readonly label: string;
  readonly home: string;
  readonly away: string;
}[] = [
  { slug: 'pista-1', label: 'Pista 1', home: 'Red Lions', away: 'Kings' },
  { slug: 'pista-2', label: 'Pista 2', home: 'Vipers', away: 'Titans' },
  { slug: 'pista-3', label: 'Pista 3', home: 'Warriors', away: 'Legends' },
];

type PilotWorkspaceView = 'configuration' | 'controls';

type ProductionPilotWorkspaceProps = {
  readonly initialView?: PilotWorkspaceView;
  readonly controlsOnly?: boolean;
  readonly navigationRole?: ProductionNavigationRole;
  readonly onSignOut?: (() => Promise<void>) | undefined;
  readonly onOpenControls?: (() => void) | undefined;
};

type ProductionPilotWorkspaceViewProps = ProductionPilotWorkspaceProps & {
  readonly pilot: ProductionPilotController;
  readonly embedded?: boolean;
};

export function ProductionPilotWorkspace(props: ProductionPilotWorkspaceProps) {
  const pilot = useProductionPilot();
  return <ProductionPilotWorkspaceView {...props} pilot={pilot} />;
}

export function ProductionPilotWorkspaceView({
  pilot, initialView = 'configuration', controlsOnly = false, navigationRole = 'admin', onSignOut,
  onOpenControls = () => window.location.assign('/mandos'), embedded = false,
}: ProductionPilotWorkspaceViewProps) {
  const view: PilotWorkspaceView = controlsOnly ? 'controls' : initialView;
  const [elapsedByCourt, setElapsedByCourt] = useState<Partial<Record<PilotCourtSlug, number>>>({});
  const recordElapsed = useCallback((court: PilotCourtSlug, seconds: number | null) => {
    setElapsedByCourt((current) => ({ ...current, [court]: seconds ?? undefined }));
  }, []);
  const shell = (children: ReactNode) => (
    <PilotShell view={view} navigationRole={navigationRole} onSignOut={onSignOut} embedded={embedded}>{children}</PilotShell>
  );

  if (pilot.state.kind === 'loading') return shell(<p className="production-pilot-loading">Cargando el centro de emisiones…</p>);
  if (pilot.state.kind === 'error') return shell(
    <div className="production-page-feedback danger" role="alert">
      <p>{pilot.state.message}</p>
      <button type="button" className="refresh-button" onClick={() => void pilot.refresh()}>Reintentar</button>
    </div>,
  );

  const ready = pilot.state;
  const sessions = COURTS.map(({ slug }) => latestSession(ready.sessions, slug));
  const activeCount = sessions.filter((session) => session && ['starting', 'live', 'stopping'].includes(session.status)).length;
  const configuredCount = COURTS.filter(({ slug }) => ready.configurations.some((item) => item.courtSlug === slug)).length;
  const unavailableSources = new Set(ready.sessions
    .filter((session) => session.source.kind === 'v4l2' && !['stopped', 'failed'].includes(session.status))
    .map((session) => session.source.id));

  return shell(<>
    <section className="production-pilot-intro" aria-labelledby={`pilot-${view}-title`}>
      <div>
        <p className="production-kicker">{view === 'configuration' ? 'Administración · preparación' : 'Operación · directo'}</p>
        <h1 id={`pilot-${view}-title`}>{view === 'configuration' ? 'Configurar emisiones' : 'Mandos de emisión'}</h1>
        <p>{view === 'configuration'
          ? 'Deja preparadas las tres pistas. Los cambios se guardan en este PC y aparecerán en Mandos.'
          : 'Controla las emisiones sin cambiar fuentes, títulos ni visibilidad.'}</p>
      </div>
      <ReadinessSummary readiness={ready.readiness} activeCount={activeCount} configuredCount={configuredCount} />
    </section>
    {ready.error ? <div className="production-page-feedback danger" role="alert">{ready.error}</div> : null}
    {view === 'configuration' ? <>
      <section className="production-pilot-courts" aria-label="Configuración de emisiones por pista">
        {COURTS.map((court) => <PilotConfigurationPanel key={court.slug} court={court}
          readiness={ready.readiness} configuration={configurationFor(ready.configurations, court.slug)}
          session={latestSession(ready.sessions, court.slug)} pending={ready.pendingCourts.includes(court.slug)}
          error={ready.courtErrors[court.slug] ?? null} unavailableSources={unavailableSources}
          onSave={(input) => pilot.configure(input)} />)}
      </section>
      <HandoffPanel configuredCount={configuredCount} onOpenControls={onOpenControls} />
    </> : <>
      <section className="production-pilot-courts production-pilot-courts--controls" aria-label="Mandos por pista">
        {COURTS.map((court) => <PilotControlPanel key={court.slug} court={court}
          configuration={configurationFor(ready.configurations, court.slug)}
          session={latestSession(ready.sessions, court.slug)} pending={ready.pendingCourts.includes(court.slug)}
          error={ready.courtErrors[court.slug] ?? null} onPrepare={(input) => void pilot.prepare(input)}
          onStart={(session) => void pilot.start(session)} onStop={(session) => void pilot.stop(session)}
          onElapsed={recordElapsed} />)}
      </section>
      <ValidationDecision readiness={ready.readiness} sessions={sessions} elapsedByCourt={elapsedByCourt} />
    </>}
  </>);
}

function PilotConfigurationPanel({
  court, readiness, configuration, session, pending, error, unavailableSources, onSave,
}: {
  readonly court: (typeof COURTS)[number];
  readonly readiness: PilotReadiness;
  readonly configuration: PilotConfiguration | null;
  readonly session: PilotSession | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly unavailableSources: ReadonlySet<string>;
  readonly onSave: (input: PreparePilotSessionInput) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<PilotMode>(configuration?.mode ?? 'simulation');
  const [homeTeam, setHomeTeam] = useState(configuration?.homeTeam ?? court.home);
  const [awayTeam, setAwayTeam] = useState(configuration?.awayTeam ?? court.away);
  const [seasonLabel, setSeasonLabel] = useState(configuration?.seasonLabel ?? 'T2');
  const [matchdayNumber, setMatchdayNumber] = useState(configuration?.matchdayNumber ?? 1);
  const [scheduledAt, setScheduledAt] = useState(() => toLocalDateTime(configuration?.scheduledAt));
  const [privacyStatus, setPrivacyStatus] = useState<PilotPrivacy>(configuration?.privacyStatus ?? 'private');
  const [sourceId, setSourceId] = useState(configuration?.sourceId ?? 'synthetic');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (configuration === null) return;
    setMode(configuration.mode);
    setHomeTeam(configuration.homeTeam);
    setAwayTeam(configuration.awayTeam);
    setSeasonLabel(configuration.seasonLabel);
    setMatchdayNumber(configuration.matchdayNumber);
    setScheduledAt(toLocalDateTime(configuration.scheduledAt));
    setPrivacyStatus(configuration.privacyStatus);
    setSourceId(configuration.sourceId);
  }, [configuration]);

  const youtubeUnavailable = mode === 'youtube' && !readiness.youtube.authorized;
  const active = session !== null && !['stopped', 'failed'].includes(session.status);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (youtubeUnavailable || pending) return;
    const didSave = await onSave({
      courtSlug: court.slug, mode, sourceId, homeTeam, awayTeam, matchdayNumber, seasonLabel,
      scheduledAt: new Date(scheduledAt).toISOString(), privacyStatus,
    });
    setSaved(didSave);
  };

  return <article className="production-pilot-court" aria-labelledby={`pilot-config-title-${court.slug}`}>
    <header className="production-pilot-court__header">
      <div><span className="production-court-card__slug">{court.slug}</span><h2 id={`pilot-config-title-${court.slug}`}>{court.label}</h2></div>
      <span className={`production-status ${configuration ? 'success' : 'info'}`}>
        {configuration ? <CircleCheck aria-hidden="true" /> : <Settings2 aria-hidden="true" />}
        {configuration ? 'Configurada' : 'Pendiente'}
      </span>
    </header>
    <form className="production-pilot-form" onSubmit={(event) => void submit(event)} onChange={() => setSaved(false)}>
      <fieldset disabled={pending}>
        <legend>Datos de la emisión</legend>
        <div className="production-pilot-mode">
          <label><input type="radio" name={`pilot-mode-${court.slug}`} checked={mode === 'simulation'} onChange={() => setMode('simulation')} />
            <span><TestTube2 aria-hidden="true" /><strong>Simulación</strong><small>Solo en este PC.</small></span></label>
          <label><input type="radio" name={`pilot-mode-${court.slug}`} checked={mode === 'youtube'} onChange={() => setMode('youtube')} />
            <span><Radio aria-hidden="true" /><strong>YouTube</strong><small>Emisión real.</small></span></label>
        </div>
        {youtubeUnavailable ? <p className="production-command-feedback danger">Conecta YouTube antes de guardar este modo.</p> : null}
        <div className="production-pilot-fields">
          <label htmlFor={`pilot-source-${court.slug}`}>Fuente</label>
          <select id={`pilot-source-${court.slug}`} value={sourceId} onChange={(event) => setSourceId(event.currentTarget.value)}>
            {readiness.sources.map((source) => <option value={source.id} key={source.id}
              disabled={source.kind === 'v4l2' && unavailableSources.has(source.id) && session?.source.id !== source.id}>
              {source.label}{source.kind === 'v4l2' && unavailableSources.has(source.id) && session?.source.id !== source.id ? ' · en uso' : ''}
            </option>)}
          </select>
          <label htmlFor={`pilot-home-${court.slug}`}>Local</label>
          <input id={`pilot-home-${court.slug}`} required value={homeTeam} onChange={(event) => setHomeTeam(event.currentTarget.value)} />
          <label htmlFor={`pilot-away-${court.slug}`}>Visitante</label>
          <input id={`pilot-away-${court.slug}`} required value={awayTeam} onChange={(event) => setAwayTeam(event.currentTarget.value)} />
          <label htmlFor={`pilot-season-${court.slug}`}>Temporada</label>
          <input id={`pilot-season-${court.slug}`} required value={seasonLabel} onChange={(event) => setSeasonLabel(event.currentTarget.value)} />
          <label htmlFor={`pilot-matchday-${court.slug}`}>Jornada</label>
          <input id={`pilot-matchday-${court.slug}`} type="number" min="1" max="999" required value={matchdayNumber}
            onChange={(event) => setMatchdayNumber(event.currentTarget.valueAsNumber)} />
          <label htmlFor={`pilot-scheduled-${court.slug}`}>Fecha y hora</label>
          <input id={`pilot-scheduled-${court.slug}`} type="datetime-local" required value={scheduledAt}
            onChange={(event) => setScheduledAt(event.currentTarget.value)} />
          <label htmlFor={`pilot-privacy-${court.slug}`}>Visibilidad</label>
          <select id={`pilot-privacy-${court.slug}`} value={privacyStatus}
            onChange={(event) => setPrivacyStatus(event.currentTarget.value as PilotPrivacy)}>
            <option value="private">Privado</option><option value="unlisted">No listado</option><option value="public">Público</option>
          </select>
        </div>
        <div className="production-pilot-config-note"><strong>Vista previa:</strong> {homeTeam || 'Local'} vs {awayTeam || 'Visitante'} · Jornada {matchdayNumber || '—'}
          <small>El título, la descripción y la miniatura se generarán al preparar la emisión desde Mandos.</small></div>
        {active ? <p className="production-command-feedback">Hay una sesión en curso. Esta configuración se usará en la siguiente.</p> : null}
        <button className="production-setup-submit" type="submit" disabled={youtubeUnavailable || pending}>
          {pending ? 'Guardando…' : saved ? 'Configuración guardada' : configuration ? 'Guardar cambios' : 'Guardar configuración'}
        </button>
      </fieldset>
      {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
    </form>
  </article>;
}

function PilotControlPanel({
  court, configuration, session, pending, error, onPrepare, onStart, onStop, onElapsed,
}: {
  readonly court: (typeof COURTS)[number];
  readonly configuration: PilotConfiguration | null;
  readonly session: PilotSession | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onPrepare: (input: PreparePilotSessionInput) => void;
  readonly onStart: (session: PilotSession) => void;
  readonly onStop: (session: PilotSession) => void;
  readonly onElapsed: (court: PilotCourtSlug, seconds: number | null) => void;
}) {
  const attemptStartedAt = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (session?.status !== 'live' || elapsedSeconds !== null || attemptStartedAt.current === null) return;
    const elapsed = Math.round((performance.now() - attemptStartedAt.current) / 1_000);
    setElapsedSeconds(elapsed);
    onElapsed(court.slug, elapsed);
  }, [court.slug, elapsedSeconds, onElapsed, session?.status]);

  const canPrepare = configuration !== null && (session === null || ['stopped', 'failed'].includes(session.status));
  const prepare = () => {
    if (configuration === null) return;
    if (configuration.mode === 'youtube' && !window.confirm(`Se creará el directo de ${court.label} en YouTube. ¿Continuar?`)) return;
    attemptStartedAt.current = performance.now();
    setElapsedSeconds(null);
    onElapsed(court.slug, null);
    onPrepare(inputFromConfiguration(configuration));
  };
  const start = () => {
    if (session === null) return;
    if (session.mode === 'youtube' && !window.confirm(`Se iniciará la emisión real de ${court.label}. ¿Continuar?`)) return;
    if (attemptStartedAt.current === null) attemptStartedAt.current = performance.now();
    onStart(session);
  };
  const stop = () => {
    if (session === null) return;
    if (session.mode === 'youtube' && !window.confirm(`Se finalizará la emisión real de ${court.label}. ¿Continuar?`)) return;
    onStop(session);
  };

  return <article className="production-pilot-court production-pilot-control" aria-labelledby={`pilot-control-title-${court.slug}`}>
    <header className="production-pilot-court__header">
      <div><span className="production-court-card__slug">{court.slug}</span><h2 id={`pilot-control-title-${court.slug}`}>{court.label}</h2></div>
      <CourtStatus session={session} />
    </header>
    <div className="production-pilot-control__body">
      {configuration === null ? <div className="production-pilot-empty-state"><Settings2 aria-hidden="true" />
        <h3>Pista sin configurar</h3><p>Pide al administrador que complete esta pista. Desde Mandos no se pueden cambiar sus datos.</p></div> : <>
        <div className="production-pilot-control__summary"><span>{configuration.mode === 'youtube' ? 'YouTube' : 'Simulación'}</span>
          <h3>{configuration.homeTeam} vs {configuration.awayTeam}</h3>
          <p>Jornada {configuration.matchdayNumber} · {configuration.sourceId === 'synthetic' ? 'Señal de prueba' : configuration.sourceId}</p>
          <p>{privacyLabel(configuration.privacyStatus)} · <time dateTime={configuration.scheduledAt}>{formatDate(configuration.scheduledAt)}</time></p></div>
        {session !== null && !['stopped', 'failed'].includes(session.status)
          ? <PilotSessionCard session={session} pending={pending} elapsedSeconds={elapsedSeconds} onStart={start} onStop={stop} />
          : <div className="production-pilot-ready-action"><p>{session?.status === 'failed'
            ? 'La última sesión falló. Puedes preparar una nueva.' : 'Configuración lista para preparar.'}</p>
            <button className="production-setup-submit" type="button" disabled={!canPrepare || pending} onClick={prepare}>
              {pending ? 'Preparando…' : configuration.mode === 'youtube' ? 'Preparar en YouTube' : 'Preparar señal'}
            </button></div>}
      </>}
      {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
      <a className="refresh-button production-pilot-visual-link" href={`/control/${court.slug}`}>
        <MonitorPlay aria-hidden="true" />Abrir control visual
      </a>
    </div>
  </article>;
}

function CourtStatus({ session }: { readonly session: PilotSession | null }) {
  const active = session && ['starting', 'live'].includes(session.status);
  const failed = session?.status === 'failed';
  return <span className={`production-status ${failed ? 'danger' : active ? 'success' : 'info'}`} aria-live="polite">
    {active ? <CircleCheck aria-hidden="true" /> : failed ? <CircleX aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
    {session ? sessionStatus(session.status) : 'Sin preparar'}
  </span>;
}

function PilotSessionCard({ session, pending, elapsedSeconds, onStart, onStop }: {
  readonly session: PilotSession;
  readonly pending: boolean;
  readonly elapsedSeconds: number | null;
  readonly onStart: () => void;
  readonly onStop: () => void;
}) {
  const active = session.status === 'starting' || session.status === 'live';
  return <div className="production-pilot-session">
    <div className="production-pilot-thumbnail"><img src={session.thumbnailUrl} alt={`Miniatura de ${session.title}`} /></div>
    <div className="production-pilot-session__copy"><h3>{session.title}</h3><p>{session.source.label} · {session.mode === 'youtube' ? 'YouTube' : 'Salida local'}</p>
      {session.encoder ? <dl className="production-pilot-metrics">
        <div><dt>FPS</dt><dd>{session.encoder.framesPerSecond.toFixed(1)}</dd></div>
        <div><dt>Bitrate</dt><dd>{Math.round(session.encoder.bitrateKbps)} kb/s</dd></div>
        <div><dt>Velocidad</dt><dd>{session.encoder.speed.toFixed(2)}×</dd></div>
        <div><dt>Frames</dt><dd>{session.encoder.frame}</dd></div>
      </dl> : null}
      {session.youtubeStreamStatus ? <p>Salud YouTube: <strong>{session.youtubeStreamStatus}</strong></p> : null}
      {elapsedSeconds !== null ? <p>Preparación hasta señal: <strong>{elapsedSeconds} s</strong></p> : null}
      {session.error ? <p className="production-command-feedback danger" role="alert">{session.error}</p> : null}
      <div className="production-pilot-actions">
        {session.status === 'prepared' ? <button className="production-setup-submit" type="button" disabled={pending} onClick={onStart}>Emitir</button> : null}
        {active ? <button className="refresh-button danger" type="button" disabled={pending} onClick={onStop}>Detener</button> : null}
        {session.watchUrl ? <a className="refresh-button" href={session.watchUrl} target="_blank" rel="noreferrer">Abrir YouTube <ExternalLink aria-hidden="true" /></a> : null}
      </div>
    </div>
  </div>;
}

function ReadinessSummary({ readiness, activeCount, configuredCount }: {
  readonly readiness: PilotReadiness;
  readonly activeCount: number;
  readonly configuredCount: number;
}) {
  return <aside className="production-pilot-readiness"><h2>Este PC</h2>
    <p>{readiness.ffmpeg.available ? '✓ FFmpeg disponible' : '✕ FFmpeg no disponible'}</p>
    <p><strong>{configuredCount}/3</strong> pistas configuradas</p><p><strong>{activeCount}/3</strong> salidas activas</p>
    <p>{readiness.sources.filter(({ kind }) => kind === 'v4l2').length} cámaras detectadas</p>
    <p>{readiness.youtube.authorized ? '✓ YouTube conectado' : 'YouTube pendiente'}</p>
    {!readiness.youtube.authorized && readiness.youtube.configured && readiness.youtube.authorizationUrl
      ? <a className="production-setup-submit" href={readiness.youtube.authorizationUrl}>Conectar YouTube</a> : null}
    {readiness.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}</aside>;
}

function HandoffPanel({ configuredCount, onOpenControls }: { readonly configuredCount: number; readonly onOpenControls: () => void }) {
  return <section className="production-pilot-handoff" aria-labelledby="pilot-handoff-title"><div>
    <p className="production-kicker">Entrega al operador</p>
    <h2 id="pilot-handoff-title">{configuredCount === 3 ? 'Las tres pistas están listas' : `Faltan ${3 - configuredCount} pistas por configurar`}</h2>
    <p>Mandos es una vista sin campos de configuración. También puedes abrirla directamente en <strong>/mandos</strong>.</p>
  </div><button className="production-setup-submit" type="button" disabled={configuredCount === 0} onClick={onOpenControls}>
    <SlidersHorizontal aria-hidden="true" />Abrir mandos</button></section>;
}

function ValidationDecision({ readiness, sessions, elapsedByCourt }: {
  readonly readiness: PilotReadiness;
  readonly sessions: readonly (PilotSession | null)[];
  readonly elapsedByCourt: Readonly<Partial<Record<PilotCourtSlug, number>>>;
}) {
  const prepared = sessions.filter(Boolean).length;
  const stable = sessions.filter((session) => session?.encoder && session.encoder.frame > 0 && session.encoder.speed >= 0.95).length;
  const youtubeHealthy = sessions.filter((session) => {
    const health = session?.youtubeStreamStatus?.toLowerCase() ?? '';
    return session?.mode === 'youtube' && session.status === 'live' && health.includes('active') && health.includes('good');
  }).length;
  const underTwoMinutes = COURTS.filter(({ slug }) => {
    const elapsed = elapsedByCourt[slug];
    return elapsed !== undefined && elapsed <= 120;
  }).length;
  const decision = youtubeHealthy === 3 ? 'Tres emisiones reales validadas'
    : stable === 3 ? 'Tres motores locales validados; falta la prueba triple en YouTube' : 'Validación de tres pistas en curso';
  return <section className="production-pilot-decision" aria-labelledby="pilot-decision-title">
    <div><p className="production-kicker">Estado de la jornada</p><h2 id="pilot-decision-title">{decision}</h2>
      <p>El operador puede controlar cada pista de forma independiente.</p></div>
    <ul><li className={readiness.ffmpeg.available ? 'passed' : ''}>FFmpeg disponible</li>
      <li className={prepared === 3 ? 'passed' : ''}>Emisiones preparadas: {prepared}/3</li>
      <li className={stable === 3 ? 'passed' : ''}>Codificación estable: {stable}/3</li>
      <li className={youtubeHealthy === 3 ? 'passed' : ''}>YouTube activo y saludable: {youtubeHealthy}/3</li>
      <li className={underTwoMinutes === 3 ? 'passed' : ''}>Preparación menor de 2 minutos: {underTwoMinutes}/3</li></ul>
  </section>;
}

function PilotShell({ children, view, navigationRole, onSignOut, embedded }: {
  readonly children: ReactNode;
  readonly view: PilotWorkspaceView;
  readonly navigationRole: ProductionNavigationRole;
  readonly onSignOut?: (() => Promise<void>) | undefined;
  readonly embedded: boolean;
}) {
  if (embedded) return <>{children}</>;
  return <main className="home-page production-overview-page production-pilot-page">
    <ProductionNavigation active={view === 'configuration' ? 'emissions' : 'controls'} role={navigationRole}
      onSignOut={onSignOut ? () => void onSignOut() : undefined} />
    {children}
  </main>;
}

function configurationFor(configurations: readonly PilotConfiguration[], courtSlug: PilotCourtSlug): PilotConfiguration | null {
  return configurations.find((configuration) => configuration.courtSlug === courtSlug) ?? null;
}

function latestSession(sessions: readonly PilotSession[], courtSlug: PilotCourtSlug): PilotSession | null {
  return [...sessions].filter((session) => session.courtSlug === courtSlug).at(-1) ?? null;
}

function inputFromConfiguration(configuration: PilotConfiguration): PreparePilotSessionInput {
  const { updatedAt, ...input } = configuration;
  void updatedAt;
  return input;
}

function toLocalDateTime(value?: string): string {
  const date = value ? new Date(value) : new Date(Date.now() + 10 * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function privacyLabel(privacy: PilotPrivacy): string {
  if (privacy === 'private') return 'Privado';
  if (privacy === 'unlisted') return 'No listado';
  return 'Público';
}

function sessionStatus(status: PilotSession['status']): string {
  switch (status) {
    case 'prepared': return 'Preparado';
    case 'starting': return 'Iniciando señal';
    case 'live': return 'Emitiendo';
    case 'stopping': return 'Deteniendo';
    case 'stopped': return 'Finalizado';
    case 'failed': return 'Fallido';
    default: return status;
  }
}
