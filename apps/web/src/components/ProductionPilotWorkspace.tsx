import { PilotThumbnailPreview } from './PilotThumbnailPreview.js';
import { PilotOperationHistory } from './PilotOperationHistory.js';
import { PilotSignalStatus } from './PilotSignalStatus.js';
import { PilotPreflightPanel } from './PilotPreflightPanel.js';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import {
  CircleCheck, CircleX, ExternalLink, Info, MonitorPlay, Radio, RefreshCw,
  Settings, Settings2, X,
} from 'lucide-react';
import {
  PILOT_MOBILE_SOURCE_ID,
  type PilotMobileCameraSession,
  type UpdatePilotMobileCameraDesiredInput,
  type PilotConfiguration,
  type PilotCourtSlug,
  type PilotMode,
  type PilotPrivacy,
  type PilotReadiness,
  type PilotSession,
  type PreparePilotSessionInput,
} from '@kpl/production-contracts';
import type { Team } from '@kpl/shared';
import { useProductionPilot, type ProductionPilotController } from '../hooks/useProductionPilot.js';
import { youtubeWatchUrl } from '../lib/pilot-youtube-watch.js';
import type { ProductionCourtSlot } from '../lib/production-overview-types.js';
import { ProductionNavigation, type ProductionNavigationRole } from './ProductionNavigation.js';
import { PilotMobileCameraMonitor, PilotMobileCameraPanel } from './PilotMobileCameraPanel.js';

const DEFAULT_BROADCAST_DESCRIPTION = 'Sigue en directo la jornada de Kings Padel League.';

type PilotWorkspaceView = 'configuration' | 'controls';

type ProductionPilotWorkspaceProps = {
  readonly monitoringActive?: boolean;
  readonly courts: readonly ProductionCourtSlot[];
  readonly inventoryStale?: boolean;
  readonly initialView?: PilotWorkspaceView;
  readonly controlsOnly?: boolean;
  readonly navigationRole?: ProductionNavigationRole;
  readonly onSignOut?: (() => Promise<void>) | undefined;
  readonly onOpenControls?: (() => void) | undefined;
  readonly preferredMode?: 'recording' | 'youtube';
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
  onOpenControls = () => window.location.assign('/admin'), preferredMode, embedded = false, courts,
  inventoryStale = false, monitoringActive = true,
}: ProductionPilotWorkspaceViewProps) {
  const view: PilotWorkspaceView = controlsOnly ? 'controls' : initialView;
  const [elapsedByCourt, setElapsedByCourt] = useState<Partial<Record<PilotCourtSlug, number>>>({});
  const generalSettingsDialog = useRef<HTMLDialogElement>(null);
  const [description, setDescription] = useState(() =>
    pilot.state.kind === 'ready'
      ? pilot.state.configurations.find((configuration) => configuration.description)?.description
        ?? DEFAULT_BROADCAST_DESCRIPTION
      : DEFAULT_BROADCAST_DESCRIPTION);
  const [recordingDirectory, setRecordingDirectory] = useState(() =>
    pilot.state.kind === 'ready'
      ? pilot.state.configurations.find((configuration) => configuration.recordingDirectory)?.recordingDirectory ?? ''
      : '');
  const descriptionInitialized = useRef(pilot.state.kind === 'ready');
  useEffect(() => {
    if (pilot.state.kind !== 'ready' || descriptionInitialized.current) return;
    setDescription(pilot.state.configurations.find((configuration) => configuration.description)?.description
      ?? DEFAULT_BROADCAST_DESCRIPTION);
    setRecordingDirectory(pilot.state.configurations.find((configuration) => configuration.recordingDirectory)?.recordingDirectory ?? '');
    descriptionInitialized.current = true;
  }, [pilot.state]);
  const recordElapsed = useCallback((court: PilotCourtSlug, seconds: number | null) => {
    setElapsedByCourt((current) => ({ ...current, [court]: seconds ?? undefined }));
  }, []);
  const shell = (children: ReactNode) => (
    <PilotShell navigationRole={navigationRole} onSignOut={onSignOut} embedded={embedded}
      inventoryStale={inventoryStale}>{children}</PilotShell>
  );

  if (pilot.state.kind === 'loading') return shell(<p className="production-pilot-loading">Cargando el centro de emisiones…</p>);
  if (pilot.state.kind === 'error') return shell(
    <div className="production-page-feedback danger" role="alert">
      <p>{pilot.state.message}</p>
      <a className="refresh-button" href={pilot.localAdminUrl}>Abrir panel local</a>
      <button type="button" className="refresh-button" onClick={() => void pilot.refresh()}>Reintentar</button>
    </div>,
  );

  const ready = pilot.state;
  const enabledCourts = courts.filter(({ productionEnabled }) => productionEnabled);
  const sessions = enabledCourts.map(({ slug }) => latestSession(ready.sessions, slug));
  const activeCount = sessions.filter((session) => session && (['starting', 'live', 'reconnecting', 'stopping'].includes(session.status)
    || (session.status === 'failed' && (session.continuity?.active || session.overlayHealth?.status === 'failed')))).length;
  const configuredCount = enabledCourts.filter(({ slug }) => ready.configurations.some((item) => item.courtSlug === slug)).length;
  const unavailableSources = new Set(ready.sessions
    .filter((session) => session.source.kind === 'v4l2' && session.status !== 'stopped')
    .map((session) => session.source.id));

  return shell(<>
    <section className="production-pilot-intro" aria-labelledby={`pilot-${view}-title`}>
      <div>
        <p className="production-kicker">{view === 'configuration' ? 'Administración · preparación' : 'Operación de pista'}</p>
        <h1 id={`pilot-${view}-title`}>{view === 'configuration' ? 'Configurar producción' : 'Control de producción'}</h1>
        <p>{view === 'configuration'
          ? 'Configura las pistas habilitadas. Los cambios se guardan de forma local en este PC.'
          : 'Supervisa y controla la salida de cada pista.'}</p>
      </div>
      <div className="production-pilot-intro__actions">
        <ReadinessSummary readiness={ready.readiness} activeCount={activeCount} configuredCount={configuredCount}
          totalCourts={enabledCourts.length} />
        {view === 'configuration' ? <button className="production-pilot-settings-trigger" type="button"
          aria-label="Abrir ajustes generales" title="Ajustes generales"
          onClick={() => generalSettingsDialog.current?.showModal()}>
          <Settings aria-hidden="true" />
        </button> : null}
      </div>
    </section>
    {ready.error ? <div className="production-page-feedback danger" role="alert">{ready.error}</div> : null}
    {view === 'configuration' ? <>
      <GeneralBroadcastSettingsDialog dialogRef={generalSettingsDialog}
        description={description} onDescriptionChange={setDescription}
        recordingDirectory={recordingDirectory} onRecordingDirectoryChange={setRecordingDirectory} />
      <section className="production-pilot-courts" aria-label="Configuración de producción por pista">
        {courts.map((court) => <PilotConfigurationPanel key={court.slug} court={court}
          teams={ready.teams} description={description} recordingDirectory={recordingDirectory}
          readiness={ready.readiness} configuration={configurationFor(ready.configurations, court.slug)}
          session={latestSession(ready.sessions, court.slug)} pending={ready.pendingCourts.includes(court.slug)}
          error={ready.courtErrors[court.slug] ?? null} unavailableSources={unavailableSources}
          mobileCamera={ready.mobileCameras.find(({ courtSlug }) => courtSlug === court.slug) ?? null}
          {...(preferredMode ? { preferredMode } : {})}
          mobileConnectUrl={ready.mobileConnectUrls[ready.mobileCameras.find(({ courtSlug }) => courtSlug === court.slug)?.id ?? ''] ?? null}
          onCreateMobile={() => pilot.createMobileCamera(court.slug)}
          onUpdateMobile={pilot.updateMobileCamera} onRevokeMobile={pilot.revokeMobileCamera}
          onSave={(input) => pilot.configure(input)} />)}
      </section>
      <HandoffPanel configuredCount={configuredCount} totalCourts={enabledCourts.length} onOpenControls={onOpenControls} />
    </> : <>
      <section className="production-pilot-courts production-pilot-courts--controls" aria-label="Control técnico por pista">
        {courts.map((court) => <PilotControlPanel key={court.slug} court={court}
          showMobileMonitor={monitoringActive}
          configuration={configurationFor(ready.configurations, court.slug)}
          session={latestSession(ready.sessions, court.slug)} pending={ready.pendingCourts.includes(court.slug)}
          error={ready.courtErrors[court.slug] ?? null} onPrepare={(input) => void pilot.prepare(input)}
          onStart={(session) => void pilot.start(session)} onRecover={(session) => void pilot.recover(session)}
          onStop={(session) => void pilot.stop(session)}
          preflight={pilot}
          mobileCamera={ready.mobileCameras.find(({ courtSlug }) => courtSlug === court.slug) ?? null}
          onElapsed={recordElapsed} />)}
      </section>
      <ValidationDecision readiness={ready.readiness} sessions={sessions} courts={enabledCourts}
        elapsedByCourt={elapsedByCourt} />
      <PilotOperationHistory />
    </>}
  </>);
}

function GeneralBroadcastSettingsDialog({
  dialogRef, description, onDescriptionChange, recordingDirectory, onRecordingDirectoryChange,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly description: string;
  readonly onDescriptionChange: (value: string) => void;
  readonly recordingDirectory: string;
  readonly onRecordingDirectoryChange: (value: string) => void;
}) {
  return <dialog className="production-pilot-settings-dialog" ref={dialogRef}
    aria-labelledby="pilot-general-title"
    onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="production-pilot-settings-dialog__panel">
      <header>
        <div><p className="production-kicker">Ajustes generales</p><h2 id="pilot-general-title">Datos compartidos</h2></div>
        <form method="dialog"><button type="submit" aria-label="Cerrar ajustes generales"><X aria-hidden="true" /></button></form>
      </header>
      <p>Estos ajustes se aplicarán a cada pista cuando guardes su configuración.</p>
      <label htmlFor="pilot-general-description">Descripción de los directos
        <textarea id="pilot-general-description" required maxLength={5_000} value={description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)} />
        <small>{description.length}/5000 caracteres</small>
      </label>
      <label htmlFor="pilot-recording-directory">Carpeta de salida de las grabaciones
        <input id="pilot-recording-directory" type="text" maxLength={4_096} value={recordingDirectory}
          placeholder="Predeterminada: data/recordings" autoComplete="off" spellCheck={false}
          onChange={(event) => onRecordingDirectoryChange(event.currentTarget.value)} />
        <small>Introduce una ruta absoluta visible para el runtime, por ejemplo <code>/mnt/grabaciones</code>. Se crearán subcarpetas por pista y sesión.</small>
      </label>
      <form method="dialog"><button className="production-setup-submit" type="submit">Listo</button></form>
    </div>
  </dialog>;
}

function PilotConfigurationPanel({
  court, teams, description, recordingDirectory, readiness, configuration, session, pending, error, unavailableSources, mobileCamera,
  mobileConnectUrl, preferredMode, onCreateMobile, onUpdateMobile, onRevokeMobile, onSave,
}: {
  readonly court: ProductionCourtSlot;
  readonly teams: readonly Team[];
  readonly description: string;
  readonly recordingDirectory: string;
  readonly readiness: PilotReadiness;
  readonly configuration: PilotConfiguration | null;
  readonly session: PilotSession | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly unavailableSources: ReadonlySet<string>;
  readonly mobileCamera: PilotMobileCameraSession | null;
  readonly mobileConnectUrl: string | null;
  readonly preferredMode?: 'recording' | 'youtube';
  readonly onCreateMobile: () => Promise<unknown>;
  readonly onUpdateMobile: (id: string, input: UpdatePilotMobileCameraDesiredInput) => Promise<boolean>;
  readonly onRevokeMobile: (id: string) => Promise<boolean>;
  readonly onSave: (input: PreparePilotSessionInput) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<PilotMode>(preferredMode ?? selectablePilotMode(configuration?.mode));
  const [homeTeam, setHomeTeam] = useState(configuration?.homeTeam
    ?? teamName(teams, court.assignment?.score?.homeTeamId, 0));
  const [awayTeam, setAwayTeam] = useState(configuration?.awayTeam
    ?? teamName(teams, court.assignment?.score?.awayTeamId, 1));
  const [seasonLabel, setSeasonLabel] = useState(configuration?.seasonLabel ?? 'T2');
  const [matchdayNumber, setMatchdayNumber] = useState(configuration?.matchdayNumber ?? 1);
  const [scheduledAt, setScheduledAt] = useState(() => toLocalDateTime(configuration?.scheduledAt));
  const [privacyStatus, setPrivacyStatus] = useState<PilotPrivacy>(configuration?.privacyStatus ?? 'private');
  const [sourceId, setSourceId] = useState(configuration?.sourceId ?? 'synthetic');
  const [saved, setSaved] = useState(false);
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const configurationRevision = configuration?.updatedAt ?? null;

  useEffect(() => {
    const savedConfiguration = configurationRef.current;
    if (savedConfiguration === null) return;
    setMode(selectablePilotMode(savedConfiguration.mode));
    setHomeTeam(savedConfiguration.homeTeam);
    setAwayTeam(savedConfiguration.awayTeam);
    setSeasonLabel(savedConfiguration.seasonLabel);
    setMatchdayNumber(savedConfiguration.matchdayNumber);
    setScheduledAt(toLocalDateTime(savedConfiguration.scheduledAt));
    setPrivacyStatus(savedConfiguration.privacyStatus);
    setSourceId(savedConfiguration.sourceId);
  }, [configurationRevision]);

  useEffect(() => {
    if (preferredMode) setMode(preferredMode);
  }, [preferredMode]);

  const youtubeUnavailable = mode === 'youtube' && !readiness.youtube.authorized;
  const active = session !== null && session.status !== 'stopped';
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (youtubeUnavailable || pending) return;
    const didSave = await onSave({
      courtSlug: court.slug, mode, sourceId, homeTeam, awayTeam, matchdayNumber, seasonLabel, description,
      ...(recordingDirectory.trim() ? { recordingDirectory: recordingDirectory.trim() } : {}),
      scheduledAt: new Date(scheduledAt).toISOString(), privacyStatus,
    });
    setSaved(didSave);
  };

  return <article className="production-pilot-court" aria-labelledby={`pilot-config-title-${court.slug}`}>
    <header className="production-pilot-court__header">
      <div><span className="production-court-card__slug">{court.slug}</span><h2 id={`pilot-config-title-${court.slug}`}>{court.name}</h2></div>
      <span className={`production-status ${!court.productionEnabled ? 'warning' : configuration ? 'success' : 'info'}`}>
        {configuration ? <CircleCheck aria-hidden="true" /> : <Settings2 aria-hidden="true" />}
        {!court.productionEnabled ? 'Producción desactivada' : configuration ? 'Configurada' : 'Pendiente'}
      </span>
    </header>
    <form className="production-pilot-form" onSubmit={(event) => void submit(event)} onChange={() => setSaved(false)}>
      <fieldset disabled={pending || active || !court.productionEnabled}>
        <legend>Datos de la producción</legend>
        <div className="production-pilot-mode">
          <label><input type="radio" name={`pilot-mode-${court.slug}`} checked={mode === 'recording'} onChange={() => setMode('recording')} />
            <span><MonitorPlay aria-hidden="true" /><strong>Grabación local</strong><small>MP4 con audio y marcador para emitir después.</small></span></label>
          <label><input type="radio" name={`pilot-mode-${court.slug}`} checked={mode === 'youtube'} onChange={() => setMode('youtube')} />
            <span><Radio aria-hidden="true" /><strong>Directo en YouTube</strong><small>Emisión real excepcional.</small></span></label>
        </div>
        {youtubeUnavailable ? <p className="production-command-feedback danger">Conecta YouTube antes de guardar este modo.</p> : null}
        <div className="production-pilot-fields">
          <label htmlFor={`pilot-source-${court.slug}`}>Fuente</label>
          <select id={`pilot-source-${court.slug}`} value={sourceId} onChange={(event) => setSourceId(event.currentTarget.value)}>
            {readiness.sources.map((source) => {
              const inUse = source.kind === 'v4l2' && unavailableSources.has(source.id) && session?.source.id !== source.id;
              return <option value={source.id} key={source.id} disabled={inUse}>
                {source.label}{inUse ? ' · en uso' : ''}
              </option>;
            })}
          </select>
          <label htmlFor={`pilot-home-${court.slug}`}>Local</label>
          <select id={`pilot-home-${court.slug}`} required value={homeTeam} onChange={(event) => setHomeTeam(event.currentTarget.value)}>
            {teams.map((team) => <option key={team.id} value={team.name}>{team.name}</option>)}
          </select>
          <label htmlFor={`pilot-away-${court.slug}`}>Visitante</label>
          <select id={`pilot-away-${court.slug}`} required value={awayTeam} onChange={(event) => setAwayTeam(event.currentTarget.value)}>
            {teams.map((team) => <option key={team.id} value={team.name}>{team.name}</option>)}
          </select>
          <label htmlFor={`pilot-season-${court.slug}`}>Temporada</label>
          <input id={`pilot-season-${court.slug}`} required value={seasonLabel} onChange={(event) => setSeasonLabel(event.currentTarget.value)} />
          <label htmlFor={`pilot-matchday-${court.slug}`}>Jornada</label>
          <input id={`pilot-matchday-${court.slug}`} type="number" min="1" max="999" required value={matchdayNumber}
            onChange={(event) => setMatchdayNumber(event.currentTarget.valueAsNumber)} />
          <label htmlFor={`pilot-scheduled-${court.slug}`}>Fecha y hora</label>
          <input id={`pilot-scheduled-${court.slug}`} type="datetime-local" required min={mode === 'youtube' ? toLocalDateTime() : undefined} value={scheduledAt}
            onChange={(event) => setScheduledAt(event.currentTarget.value)} />
          {mode === 'youtube' ? <><label htmlFor={`pilot-privacy-${court.slug}`}>Visibilidad</label>
          <select id={`pilot-privacy-${court.slug}`} value={privacyStatus}
            onChange={(event) => setPrivacyStatus(event.currentTarget.value as PilotPrivacy)}>
            <option value="private">Privado</option><option value="unlisted">No listado</option><option value="public">Público</option>
          </select></> : null}
        </div>
        <div className="production-pilot-config-note"><strong>Vista previa:</strong> {homeTeam || 'Local'} vs {awayTeam || 'Visitante'} · Jornada {matchdayNumber || '—'}
          <small>{mode === 'youtube' ? 'Esta portada se subirá a YouTube al preparar la emisión. Se usará la descripción general.' : 'Se usará la descripción general del partido.'}</small></div>
        <PilotThumbnailPreview homeTeam={homeTeam} awayTeam={awayTeam} matchdayNumber={matchdayNumber} />
        {active ? <p className="production-command-feedback">Hay una sesión en curso. Esta configuración se usará en la siguiente.</p> : null}
        <button className="production-setup-submit" type="submit" disabled={youtubeUnavailable || pending || !court.productionEnabled}>
          {pending ? 'Guardando…' : saved ? 'Configuración guardada' : configuration ? 'Guardar cambios' : 'Guardar configuración'}
        </button>
      </fieldset>
      {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
    </form>
    {sourceId === PILOT_MOBILE_SOURCE_ID || mobileCamera?.courtSlug === court.slug ? <div className="production-pilot-form">
      <PilotMobileCameraPanel courtSlug={court.slug} mobileCamera={mobileCamera} connectUrl={mobileConnectUrl}
        active={active} pending={pending} onCreate={onCreateMobile} onUpdate={onUpdateMobile} onRevoke={onRevokeMobile} />
    </div> : null}
  </article>;
}

function selectablePilotMode(mode: PilotMode | undefined): PilotMode {
  return mode === 'youtube' ? 'youtube' : 'recording';
}

export function PilotControlPanel({
  court, configuration, session, pending, error, mobileCamera, onPrepare, onStart, onRecover, onStop, onElapsed, preflight,
  showMobileMonitor = true, showVisualLink = true, idPrefix = 'pilot-control',
}: {
  readonly showMobileMonitor?: boolean;
  readonly showVisualLink?: boolean;
  readonly idPrefix?: string;
  readonly court: ProductionCourtSlot;
  readonly configuration: PilotConfiguration | null;
  readonly session: PilotSession | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly mobileCamera: PilotMobileCameraSession | null;
  readonly onPrepare: (input: PreparePilotSessionInput) => void;
  readonly onStart: (session: PilotSession) => void;
  readonly onRecover: (session: PilotSession) => void;
  readonly onStop: (session: PilotSession) => void;
  readonly onElapsed: (court: PilotCourtSlug, seconds: number | null) => void;
  readonly preflight: Pick<ProductionPilotController, 'preflight' | 'cancelPreflight' | 'preview'>;
}) {
  const attemptStartedAt = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (session?.status !== 'live' || elapsedSeconds !== null || attemptStartedAt.current === null) return;
    const elapsed = Math.round((performance.now() - attemptStartedAt.current) / 1_000);
    setElapsedSeconds(elapsed);
    onElapsed(court.slug, elapsed);
  }, [court.slug, elapsedSeconds, onElapsed, session?.status]);

  const canPrepare = court.productionEnabled && configuration !== null
    && (session === null || session.status === 'stopped');
  const prepare = () => {
    if (configuration === null) return;
    if (configuration.mode === 'youtube' && !window.confirm(`Se creará el directo de ${court.name} en YouTube. ¿Continuar?`)) return;
    attemptStartedAt.current = performance.now();
    setElapsedSeconds(null);
    onElapsed(court.slug, null);
    onPrepare(inputFromConfiguration(configuration));
  };
  const start = () => {
    if (session === null) return;
    if (session.mode === 'youtube' && !window.confirm(`Se iniciará la emisión real de ${court.name}. ¿Continuar?`)) return;
    if (attemptStartedAt.current === null) attemptStartedAt.current = performance.now();
    onStart(session);
  };
  const stop = () => {
    if (session === null) return;
    if (session.mode === 'youtube' && !window.confirm(session.status === 'prepared' || session.preparationPending
      ? `Se cancelará la emisión programada de ${court.name} en YouTube. ¿Continuar?`
      : `Se finalizará la emisión real de ${court.name}. ¿Continuar?`)) return;
    onStop(session);
  };
  const recover = () => {
    if (session === null) return;
    if (session.mode === 'youtube' && !window.confirm(
      session.preparationPending
        ? `Se recuperará la preparación de ${court.name} sin crear otro directo. La emisión no se iniciará hasta que pulses Emitir. ¿Continuar?`
        : `Se reutilizará el mismo directo de ${court.name} en YouTube. Comprueba primero que la cámara está disponible. ¿Recuperar emisión?`,
    )) return;
    if (attemptStartedAt.current === null) attemptStartedAt.current = performance.now();
    onRecover(session);
  };

  return <article className="production-pilot-court production-pilot-control" aria-labelledby={`${idPrefix}-title-${court.slug}`}>
    <header className="production-pilot-court__header">
      <div><span className="production-court-card__slug">{court.slug}</span><h2 id={`${idPrefix}-title-${court.slug}`}>{court.name}</h2></div>
      <CourtStatus session={session} enabled={court.productionEnabled} />
    </header>
    <div className="production-pilot-control__body">
      {!court.productionEnabled ? <div className="production-pilot-empty-state"><Settings2 aria-hidden="true" />
        <h3>Producción desactivada</h3><p>Esta pista está deshabilitada en la configuración autoritativa.</p></div>
        : configuration === null ? <div className="production-pilot-empty-state"><Settings2 aria-hidden="true" />
        <h3>Pista sin configurar</h3><p>Completa la configuración técnica de esta pista antes de preparar la salida.</p></div> : <>
        <div className="production-pilot-control__summary"><span>{configuration.mode === 'youtube' ? 'YouTube' : configuration.mode === 'recording' ? 'Grabación local' : 'Simulación'}</span>
          <h3>{configuration.homeTeam} vs {configuration.awayTeam}</h3>
          <p>Jornada {configuration.matchdayNumber} · {configuration.sourceId === 'synthetic' ? 'Señal de prueba' : configuration.sourceId}</p>
          <p>{configuration.mode === 'youtube' ? `${privacyLabel(configuration.privacyStatus)} · ` : ''}<time dateTime={configuration.scheduledAt}>{formatDate(configuration.scheduledAt)}</time></p></div>
        {showMobileMonitor && configuration.sourceId === PILOT_MOBILE_SOURCE_ID && mobileCamera !== null
          ? <PilotMobileCameraMonitor mobileCamera={mobileCamera} /> : null}
        {session?.recordingFiles?.length ? <div className="production-command-feedback production-pilot-recordings">
          <strong>{session.status === 'stopped' ? 'Grabaciones guardadas' : 'Archivos de grabación'}</strong>
          <p>En el PC del runtime. Pulsa Detener antes de utilizarlos para el falso directo.</p>
          <ul>{session.recordingFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        </div> : null}
        {session !== null && session.status !== 'stopped'
          ? <PilotSessionCard session={session} pending={pending} elapsedSeconds={elapsedSeconds}
            preflight={preflight}
            onStart={start} onRecover={recover} onStop={stop} />
          : <div className="production-pilot-ready-action"><p>Configuración lista para preparar.</p>
            <button className="production-setup-submit" type="button" disabled={!canPrepare || pending} onClick={prepare}>
              {pending ? 'Preparando…' : configuration.mode === 'youtube' ? 'Preparar en YouTube' : configuration.mode === 'recording' ? 'Preparar grabación' : 'Preparar señal'}
            </button></div>}
      </>}
      {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
      {showVisualLink ? <a className="refresh-button production-pilot-visual-link" href={`/control/${court.slug}`}>
        <MonitorPlay aria-hidden="true" />Abrir control visual
      </a> : null}
    </div>
  </article>;
}

function CourtStatus({ session, enabled }: { readonly session: PilotSession | null; readonly enabled: boolean }) {
  if (!enabled) return <span className="production-status warning">Producción desactivada</span>;
  if (session?.status === 'prepared') {
    const hasNotices = session.preflight && ['blocked', 'warning'].includes(session.preflight.status);
    return <span className={`production-status ${hasNotices ? 'warning' : 'info'}`}>
      {session.preflight?.status === 'running' ? 'Comprobando' : hasNotices ? 'Preparada · Con avisos' : 'Preparada'}
    </span>;
  }
  const live = session?.status === 'live';
  const recovering = session?.status === 'reconnecting';
  const continuity = session?.continuity?.active && ['starting', 'live', 'reconnecting', 'failed'].includes(session.status);
  const overlayWarning = session?.overlayHealth && session.overlayHealth.status !== 'ready'
    && ['starting', 'live', 'reconnecting', 'failed'].includes(session.status);
  const signalWarning = ['starting', 'live', 'reconnecting'].includes(session?.status ?? '')
    && (session?.signal?.issues.length ?? 0) > 0;
  const failed = session?.status === 'failed' || session?.status === 'interrupted';
  return <span className={`production-status ${failed ? 'danger' : recovering || signalWarning || continuity || overlayWarning ? 'warning' : live ? 'success' : 'info'}`} aria-live="polite">
    {failed ? <CircleX aria-hidden="true" /> : signalWarning || overlayWarning || continuity ? <Info aria-hidden="true" /> : live ? <CircleCheck aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
    {continuity ? 'Continuidad · Revisar cámara' : overlayWarning ? 'Revisar marcador'
      : session ? `${session.mode === 'recording' && session.status === 'live' ? 'Grabando' : sessionStatus(session.status)}${signalWarning ? ' · Revisar señal' : ''}` : 'Sin preparar'}
  </span>;
}

function PilotSessionCard({ session, pending, elapsedSeconds, onStart, onRecover, onStop, preflight }: {
  readonly session: PilotSession;
  readonly pending: boolean;
  readonly elapsedSeconds: number | null;
  readonly onStart: () => void;
  readonly preflight: Pick<ProductionPilotController, 'preflight' | 'cancelPreflight' | 'preview'>;
  readonly onRecover: () => void;
  readonly onStop: () => void;
}) {
  const active = ['starting', 'live', 'reconnecting'].includes(session.status);
  const continuity = session.continuity?.active && (active || session.status === 'failed');
  const overlay = (active || session.status === 'failed') && session.overlayHealth?.status !== 'ready' ? session.overlayHealth : null;
  const watchUrl = youtubeWatchUrl(session);
  return <div className="production-pilot-session">
    <div className="production-pilot-thumbnail"><img src={session.thumbnailUrl} alt={`Miniatura de ${session.title}`} /></div>
    <div className="production-pilot-session__copy"><h3>{session.title}</h3><p>{session.source.label} · {session.mode === 'youtube' ? 'YouTube' : session.mode === 'recording' ? 'Grabación local' : 'Simulación'}</p>
      {session.videoEncoding ? <p>Codificación: <strong>{session.videoEncoding.label}</strong></p> : null}
      {session.encodingWarning ? <p className="production-command-feedback warning" role="status">{session.encodingWarning}</p> : null}
      {session.encoder ? <dl className="production-pilot-metrics">
        <div><dt>FPS</dt><dd>{session.encoder.framesPerSecond.toFixed(1)}</dd></div>
        <div><dt>Bitrate</dt><dd>{Math.round(session.encoder.bitrateKbps)} kb/s</dd></div>
        <div><dt>Velocidad</dt><dd>{session.encoder.speed.toFixed(2)}×</dd></div>
        <div><dt>Frames</dt><dd>{session.encoder.frame}</dd></div>
      </dl> : null}
      {session.youtubeStreamStatus ? <p>Salud YouTube: <strong>{session.youtubeStreamStatus}</strong></p> : null}
      {overlay ? <div className="production-command-feedback warning" role="alert">
        <strong>Revisar marcador de {session.courtSlug}</strong>
        <p>{overlay.holdingLastFrame ? 'Se conserva la última imagen del marcador mientras continúa el vídeo. El tanteo mostrado puede estar desactualizado.'
          : 'La salida espera a recibir el marcador del partido configurado.'}</p>
        <p>{overlay.reason}</p>
        {overlay.lastFrameAt ? <p>Última imagen válida: <time dateTime={overlay.lastFrameAt}>{new Date(overlay.lastFrameAt).toLocaleTimeString('es-ES')}</time>.</p> : null}
        {overlay.status !== 'failed' ? <p>Reintentos del marcador: {overlay.attempt}/5.</p> : null}
      </div> : null}
      {continuity ? <div className="production-command-feedback warning" role="alert">
        <strong>Mostrando continuidad en {session.courtSlug}</strong>
        <p>La salida mantiene una imagen de espera y el marcador, con audio en silencio.</p>
        <p>{session.continuity?.reason}</p>
        {!session.continuity?.exhausted ? <p>Reintentos de cámara: {session.continuity?.attempt}/5.</p> : null}
      </div> : null}
      {active || continuity || overlay?.holdingLastFrame ? <PilotSignalStatus signal={session.signal} courtSlug={session.courtSlug} continuity={Boolean(continuity)} /> : null}
      {elapsedSeconds !== null ? <p>Preparación hasta señal: <strong>{elapsedSeconds} s</strong></p> : null}
      {session.error ? <p className="production-command-feedback danger" role="alert">{session.error}</p> : null}
      <div className="production-pilot-actions">
        {session.status === 'prepared' ? <button className="production-setup-submit" type="button" disabled={pending || session.preflight?.status === 'running'} onClick={onStart}>{session.mode === 'recording' ? 'Grabar' : 'Emitir'}</button> : null}
        {session.status === 'interrupted' || session.status === 'failed'
          ? <button className="production-setup-submit" type="button" disabled={pending} onClick={onRecover}>
            {session.preparationPending ? 'Recuperar preparación' : 'Recuperar emisión'}
          </button> : null}
        {active || ['preparing', 'prepared', 'interrupted', 'failed'].includes(session.status)
          ? <button className="refresh-button danger" type="button" disabled={pending && session.status !== 'preparing'} onClick={onStop}>
            {session.status === 'prepared' || session.status === 'preparing' ? 'Cancelar preparación' : active ? 'Detener' : 'Finalizar sesión'}
          </button> : null}
        {watchUrl ? <a className="production-setup-submit production-pilot-youtube-link" href={watchUrl}
          target="_blank" rel="noreferrer">Ver directo en YouTube <ExternalLink aria-hidden="true" /></a> : null}
      </div>
      {session.status === 'prepared' ? <PilotPreflightPanel session={session} pending={pending}
        onCheck={(check) => void preflight.preflight(session, check)} onCancel={() => void preflight.cancelPreflight(session)}
        onStart={onStart} loadPreview={preflight.preview} /> : null}
    </div>
  </div>;
}

function ReadinessSummary({ readiness, activeCount, configuredCount, totalCourts }: {
  readonly readiness: PilotReadiness;
  readonly activeCount: number;
  readonly configuredCount: number;
  readonly totalCourts: number;
}) {
  return <details className="production-pilot-readiness">
    <summary aria-label="Información de este PC" title="Información de este PC"><Info aria-hidden="true" /></summary>
    <aside><h2>Este PC</h2>
      <p>{readiness.ffmpeg.available ? '✓ FFmpeg disponible' : '✕ FFmpeg no disponible'}</p>
      {readiness.ffmpeg.encoders?.filter(({ hardware }) => hardware).map((encoder) =>
        <p key={`${encoder.name}:${encoder.device}`}>✓ {encoder.label} disponible · {encoder.frameRates.join('/')} FPS</p>)}
      <p><strong>{configuredCount}/{totalCourts}</strong> pistas configuradas</p><p><strong>{activeCount}/{totalCourts}</strong> salidas activas</p>
      <p>{readiness.sources.filter(({ kind }) => kind === 'v4l2').length} cámaras detectadas</p>
      <p>{readiness.youtube.authorized ? '✓ YouTube conectado' : 'YouTube pendiente'}</p>
      {!readiness.youtube.authorized && readiness.youtube.configured && readiness.youtube.authorizationUrl
        ? <a className="production-setup-submit" href={readiness.youtube.authorizationUrl}>Conectar YouTube</a> : null}
      {readiness.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}</aside>
  </details>;
}

function HandoffPanel({ configuredCount, totalCourts, onOpenControls }: {
  readonly configuredCount: number;
  readonly totalCourts: number;
  readonly onOpenControls: () => void;
}) {
  const missing = Math.max(0, totalCourts - configuredCount);
  return <section className="production-pilot-handoff" aria-labelledby="pilot-handoff-title"><div>
    <p className="production-kicker">Configuración</p>
    <h2 id="pilot-handoff-title">{totalCourts === 0 ? 'No hay pistas habilitadas'
      : missing === 0 ? 'Todas las pistas están listas' : `Faltan ${missing} pistas por configurar`}</h2>
    <p>Guarda cada pista necesaria y vuelve a Producción para preparar, iniciar y supervisar la salida.</p>
  </div><button className="production-setup-submit" type="button" disabled={configuredCount === 0} onClick={onOpenControls}>
    <CircleCheck aria-hidden="true" />Volver a Producción</button></section>;
}

function ValidationDecision({ readiness, sessions, courts, elapsedByCourt }: {
  readonly readiness: PilotReadiness;
  readonly sessions: readonly (PilotSession | null)[];
  readonly courts: readonly ProductionCourtSlot[];
  readonly elapsedByCourt: Readonly<Partial<Record<PilotCourtSlug, number>>>;
}) {
  const prepared = sessions.filter((session) => session && ['prepared', 'starting', 'live', 'reconnecting', 'stopping'].includes(session.status)).length;
  const stable = sessions.filter((session) => session?.status === 'live' && session.encoder && session.encoder.frame > 0 && session.encoder.speed >= 0.95).length;
  const youtubeHealthy = sessions.filter((session) => {
    const health = session?.youtubeStreamStatus?.toLowerCase() ?? '';
    return session?.mode === 'youtube' && session.status === 'live' && health.includes('active') && health.includes('good');
  }).length;
  const underTwoMinutes = courts.filter(({ slug }) => {
    const elapsed = elapsedByCourt[slug];
    return elapsed !== undefined && elapsed <= 120;
  }).length;
  const total = courts.length;
  const needsPreparation = sessions.filter((session) => !session || ['stopped', 'failed', 'interrupted', 'preparing'].includes(session.status)).length;
  const decision = needsPreparation > 0 ? 'Hay pistas pendientes de preparar'
    : total > 0 && youtubeHealthy === total ? 'YouTube recibe señal de todas las pistas'
    : total > 0 && stable === total ? 'Los programas locales producen señal; falta comprobar YouTube'
      : total > 0 && sessions.every((session) => session?.status === 'prepared') ? 'Emisiones preparadas para iniciar'
        : 'Validación de pistas en curso';
  return <section className="production-pilot-decision" aria-labelledby="pilot-decision-title">
    <div><p className="production-kicker">Estado de la jornada</p><h2 id="pilot-decision-title">{decision}</h2>
      <p>El operador puede controlar cada pista de forma independiente.</p></div>
    <ul><li className={readiness.ffmpeg.available ? 'passed' : ''}>FFmpeg disponible</li>
      <li className={needsPreparation === 0 && total > 0 ? 'passed' : ''}>Pistas pendientes de preparar: {needsPreparation}</li>
      <li className={total > 0 && prepared === total ? 'passed' : ''}>Emisiones preparadas: {prepared}/{total}</li>
      <li className={total > 0 && stable === total ? 'passed' : ''}>Codificación estable: {stable}/{total}</li>
      <li className={total > 0 && youtubeHealthy === total ? 'passed' : ''}>YouTube activo y saludable: {youtubeHealthy}/{total}</li>
      <li className={total > 0 && underTwoMinutes === total ? 'passed' : ''}>Preparación menor de 2 minutos: {underTwoMinutes}/{total}</li></ul>
  </section>;
}

function PilotShell({ children, navigationRole, onSignOut, embedded, inventoryStale }: {
  readonly children: ReactNode;
  readonly navigationRole: ProductionNavigationRole;
  readonly onSignOut?: (() => Promise<void>) | undefined;
  readonly embedded: boolean;
  readonly inventoryStale: boolean;
}) {
  if (embedded) return <>{children}</>;
  return <main className="home-page production-overview-page production-pilot-page">
    <ProductionNavigation active="production" role={navigationRole}
      onSignOut={onSignOut ? () => void onSignOut() : undefined} />
    {inventoryStale ? <div className="production-page-feedback danger" role="status">
      No se pudo actualizar el inventario de Supabase. Se conserva la última configuración válida;
      revisa las pistas antes de iniciar una emisión.
    </div> : null}
    {children}
  </main>;
}

function configurationFor(configurations: readonly PilotConfiguration[], courtSlug: PilotCourtSlug): PilotConfiguration | null {
  return configurations.find((configuration) => configuration.courtSlug === courtSlug) ?? null;
}

function latestSession(sessions: readonly PilotSession[], courtSlug: PilotCourtSlug): PilotSession | null {
  return [...sessions].filter((session) => session.courtSlug === courtSlug).at(-1) ?? null;
}

function teamName(teams: readonly Team[], teamId: string | undefined, fallbackIndex: number): string {
  return teams.find((team) => team.id === teamId)?.name ?? teams[fallbackIndex]?.name ?? teams[0]?.name ?? '';
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
    case 'preparing': return 'Preparando destino';
    case 'prepared': return 'Preparado';
    case 'starting': return 'Iniciando señal';
    case 'live': return 'Emitiendo';
    case 'reconnecting': return 'Recuperando señal';
    case 'interrupted': return 'Interrumpida';
    case 'stopping': return 'Deteniendo';
    case 'stopped': return 'Finalizado';
    case 'failed': return 'Fallido';
    default: return status;
  }
}
