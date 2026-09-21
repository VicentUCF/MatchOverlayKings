import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import {
  ArrowLeft, ArrowRight, Camera, Check, Circle, Eye, EyeOff, FolderOpen,
  MonitorPlay, Smartphone, Video,
} from 'lucide-react';
import {
  PILOT_MOBILE_SOURCE_ID,
  type PilotConfiguration,
  type PilotCourtSlug,
  type PilotMobileCameraSession,
  type PilotPrivacy,
  type PreparePilotSessionInput,
} from '@kpl/production-contracts';
import { DEFAULT_OVERLAY_SETTINGS, type OverlayPosition, type Team } from '@kpl/shared';
import type { ProductionPilotController, ReadyPilotState } from '../hooks/useProductionPilot.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';
import type { ProductionCourtSlot } from '../lib/production-overview-types.js';
import { PilotMobileCameraPanel, MobileCameraPreview } from './PilotMobileCameraPanel.js';
import { ScorerAccess } from './ProductionCourtMonitor.js';

type ProductionKind = 'recording' | 'youtube';
type CourtStep = 'match' | 'camera' | 'view' | 'operator';

const STEPS: readonly { readonly id: CourtStep; readonly label: string }[] = [
  { id: 'match', label: 'Partido' },
  { id: 'camera', label: 'Cámara' },
  { id: 'view', label: 'Vista' },
  { id: 'operator', label: 'Operador' },
];

export function ProductionSetupWizard({ pilot, courts, kind, onBack, onComplete }: {
  readonly pilot: ProductionPilotController;
  readonly courts: readonly ProductionCourtSlot[];
  readonly kind: ProductionKind;
  readonly onBack: () => void;
  readonly onComplete: () => void;
}) {
  const [selectedCourts, setSelectedCourts] = useState<readonly PilotCourtSlug[]>([]);
  const [selectionDone, setSelectionDone] = useState(false);
  const [courtIndex, setCourtIndex] = useState(0);
  const [completedCourts, setCompletedCourts] = useState<readonly PilotCourtSlug[]>([]);
  const [step, setStep] = useState<CourtStep>('match');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const ready = pilot.state.kind === 'ready' ? pilot.state : null;
  const initialConfiguration = ready?.configurations.find((configuration) => configuration.mode === kind) ?? null;
  const [seasonLabel, setSeasonLabel] = useState(initialConfiguration?.seasonLabel ?? 'T2');
  const [matchdayNumber, setMatchdayNumber] = useState(initialConfiguration?.matchdayNumber ?? 1);
  const [recordingDirectory, setRecordingDirectory] = useState(initialConfiguration?.recordingDirectory ?? '');
  const commonSettingsInitialized = useRef(initialConfiguration !== null);
  const enabledCourts = courts.filter(({ productionEnabled }) => productionEnabled);
  const selected = selectedCourts
    .map((slug) => enabledCourts.find((court) => court.slug === slug))
    .filter((court): court is ProductionCourtSlot => court !== undefined);
  const currentCourt = selected[courtIndex] ?? null;

  useEffect(() => {
    if (selectionDone) headingRef.current?.focus();
  }, [courtIndex, selectionDone, step]);

  useEffect(() => {
    if (ready === null || commonSettingsInitialized.current) return;
    const configuration = ready.configurations.find((candidate) => candidate.mode === kind);
    if (configuration) {
      setSeasonLabel(configuration.seasonLabel);
      setMatchdayNumber(configuration.matchdayNumber);
      setRecordingDirectory(configuration.recordingDirectory ?? '');
    }
    commonSettingsInitialized.current = true;
  }, [kind, ready]);

  if (ready === null) {
    return <div className="production-page-feedback" role="status">Preparando el asistente de configuración…</div>;
  }

  if (!selectionDone) {
    return <CourtSelection kind={kind} courts={enabledCourts} state={ready} selected={selectedCourts}
      seasonLabel={seasonLabel} matchdayNumber={matchdayNumber} recordingDirectory={recordingDirectory}
      onSeasonLabel={setSeasonLabel} onMatchdayNumber={setMatchdayNumber} onRecordingDirectory={setRecordingDirectory}
      onToggle={(slug) => setSelectedCourts((current) => current.includes(slug)
        ? current.filter((candidate) => candidate !== slug)
        : [...current, slug])}
      onBack={onBack} onContinue={() => {
        if (selectedCourts.length === 0) return;
        setSelectionDone(true);
        setCourtIndex(0);
        setStep('match');
      }} />;
  }

  if (currentCourt === null) return null;
  const completed = completedCourts.length;
  const finishCourt = () => {
    setCompletedCourts((current) => current.includes(currentCourt.slug) ? current : [...current, currentCourt.slug]);
    if (courtIndex < selected.length - 1) {
      setCourtIndex((current) => current + 1);
      setStep('match');
      return;
    }
    onComplete();
  };

  return <section className="production-wizard" aria-labelledby="production-wizard-title">
    <header className="production-wizard__header">
      <div><p className="production-kicker">Preparación guiada</p><h2 id="production-wizard-title">Configurar {kind === 'recording' ? 'grabaciones' : 'directos'}</h2>
        <p>Prepara cada pista y después inicia la {kind === 'recording' ? 'grabación' : 'emisión'} manualmente desde Producción.</p></div>
      <div className="production-wizard__progress" role="status" aria-live="polite">
        <strong>{completed} de {selected.length} pistas completadas</strong>
        <progress value={completed} max={selected.length}>{completed} de {selected.length}</progress>
      </div>
    </header>
    <div className="production-wizard__layout">
      <nav className="production-wizard__courts" aria-label="Pistas seleccionadas">
        {selected.map((court, index) => {
          const isComplete = completedCourts.includes(court.slug);
          const active = index === courtIndex;
          return <button key={court.slug} type="button" aria-current={active ? 'step' : undefined}
            disabled={!active && !isComplete} onClick={() => { setCourtIndex(index); setStep('match'); }}>
            <span className={`production-wizard__court-icon ${isComplete ? 'is-complete' : ''}`}>
              {isComplete ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            </span>
            <span><strong>{court.name}</strong><small>{isComplete ? 'Lista' : active ? 'Configurando' : 'Pendiente'}</small></span>
          </button>;
        })}
      </nav>
      <CourtWizard key={`${currentCourt.slug}:${kind}`} court={currentCourt} kind={kind} ready={ready} pilot={pilot}
        seasonLabel={seasonLabel} matchdayNumber={matchdayNumber} recordingDirectory={recordingDirectory}
        step={step} setStep={setStep} headingRef={headingRef}
        onBackToSelection={() => { setSelectionDone(false); setStep('match'); }} onFinish={finishCourt}
        nextCourtName={selected[courtIndex + 1]?.name ?? null} />
    </div>
  </section>;
}

function CourtSelection({ kind, courts, state, selected, seasonLabel, matchdayNumber, recordingDirectory,
  onSeasonLabel, onMatchdayNumber, onRecordingDirectory, onToggle, onBack, onContinue }: {
  readonly kind: ProductionKind;
  readonly courts: readonly ProductionCourtSlot[];
  readonly state: ReadyPilotState;
  readonly selected: readonly PilotCourtSlug[];
  readonly seasonLabel: string;
  readonly matchdayNumber: number;
  readonly recordingDirectory: string;
  readonly onSeasonLabel: (value: string) => void;
  readonly onMatchdayNumber: (value: number) => void;
  readonly onRecordingDirectory: (value: string) => void;
  readonly onToggle: (slug: PilotCourtSlug) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  return <section className="production-wizard production-wizard--selection" aria-labelledby="court-selection-title">
    <header className="production-wizard__header"><div><p className="production-kicker">Nueva producción</p>
      <h2 id="court-selection-title">¿Qué pistas quieres {kind === 'recording' ? 'grabar' : 'emitir'}?</h2>
      <p>Selecciona una o varias. Después configuraremos cada pista por separado.</p></div>
      <span className="production-wizard__kind"><MonitorPlay aria-hidden="true" />{kind === 'recording' ? 'Grabación local' : 'Directo en YouTube'}</span>
    </header>
    <form className="production-wizard__selection-form" onSubmit={(event) => { event.preventDefault(); onContinue(); }}>
      <fieldset className="production-wizard__common-settings">
        <legend>Ajustes para toda la producción</legend>
        <p>Se aplicarán automáticamente a todas las pistas seleccionadas.</p>
        <div className="production-wizard__fields">
          <label>Temporada<input required value={seasonLabel} onChange={(event) => onSeasonLabel(event.currentTarget.value)} /></label>
          <label>Jornada<input type="number" min="1" max="999" required value={matchdayNumber}
            onChange={(event) => onMatchdayNumber(event.currentTarget.valueAsNumber)} /></label>
          {kind === 'recording' ? <label>Carpeta de grabaciones<span className="production-wizard__folder-input">
            <FolderOpen aria-hidden="true" /><input value={recordingDirectory} placeholder="Usar la carpeta predeterminada"
              onChange={(event) => onRecordingDirectory(event.currentTarget.value)} /></span>
            <small>Todos los archivos de esta producción se guardarán aquí.</small></label> : null}
        </div>
      </fieldset>
      <fieldset className="production-wizard__court-selection">
        <legend className="production-sr-only">Pistas incluidas</legend>
        {courts.length === 0 ? <p className="production-page-feedback" role="status">
          No hay pistas habilitadas. Activa al menos una pista antes de crear una producción.
        </p> : null}
        {courts.map((court) => {
          const active = state.sessions.some((session) => session.courtSlug === court.slug && session.status !== 'stopped');
          const checked = selected.includes(court.slug);
          const configured = state.configurations.some((configuration) => configuration.courtSlug === court.slug);
          return <label key={court.slug} className={checked ? 'is-selected' : ''}>
            <input type="checkbox" checked={checked} disabled={active} onChange={() => onToggle(court.slug)} />
            <span className="production-wizard__selection-check"><Check aria-hidden="true" /></span>
            <span><strong>{court.name}</strong><small>{active ? 'Tiene una sesión activa' : configured ? 'Configurada anteriormente' : 'Disponible'}</small></span>
          </label>;
        })}
      </fieldset>
      <WizardFooter onBack={onBack} backLabel="Cambiar tipo">
        <button className="production-setup-submit" type="submit" disabled={selected.length === 0}>
          {selected.length === 0 ? 'Selecciona al menos una pista' : `Configurar ${selected.length} ${selected.length === 1 ? 'pista' : 'pistas'}`}
          <ArrowRight aria-hidden="true" />
        </button>
      </WizardFooter>
    </form>
  </section>;
}

function CourtWizard({ court, kind, ready, pilot, seasonLabel, matchdayNumber, recordingDirectory,
  step, setStep, headingRef, onBackToSelection, onFinish, nextCourtName }: {
  readonly court: ProductionCourtSlot;
  readonly kind: ProductionKind;
  readonly ready: ReadyPilotState;
  readonly pilot: ProductionPilotController;
  readonly seasonLabel: string;
  readonly matchdayNumber: number;
  readonly recordingDirectory: string;
  readonly step: CourtStep;
  readonly setStep: (step: CourtStep) => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onBackToSelection: () => void;
  readonly onFinish: () => void;
  readonly nextCourtName: string | null;
}) {
  const configuration = ready.configurations.find(({ courtSlug }) => courtSlug === court.slug) ?? null;
  const mobileCamera = ready.mobileCameras.find(({ courtSlug, state }) => courtSlug === court.slug && state !== 'revoked') ?? null;
  const initialSource = configuration?.sourceId
    ?? (mobileCamera && ready.readiness.sources.some(({ id }) => id === PILOT_MOBILE_SOURCE_ID)
      ? PILOT_MOBILE_SOURCE_ID : ready.readiness.sources[0]?.id ?? 'synthetic');
  const [homeTeam, setHomeTeam] = useState(configuration?.homeTeam ?? teamName(ready.teams, court.assignment?.score?.homeTeamId, 0));
  const [awayTeam, setAwayTeam] = useState(configuration?.awayTeam ?? teamName(ready.teams, court.assignment?.score?.awayTeamId, 1));
  const [scheduledAt, setScheduledAt] = useState(() => toLocalDateTime(configuration?.scheduledAt));
  const [privacyStatus, setPrivacyStatus] = useState<PilotPrivacy>(configuration?.privacyStatus ?? 'private');
  const [description, setDescription] = useState(configuration?.description ?? 'Sigue la jornada de Kings Padel League.');
  const [sourceId, setSourceId] = useState(initialSource);
  const [saving, setSaving] = useState(false);
  const active = ready.sessions.some((session) => session.courtSlug === court.slug && session.status !== 'stopped');
  const pending = ready.pendingCourts.includes(court.slug) || saving;
  const error = ready.courtErrors[court.slug] ?? null;
  const stepIndex = STEPS.findIndex(({ id }) => id === step);
  const connectUrl = mobileCamera ? ready.mobileConnectUrls[mobileCamera.id] ?? null : null;
  const draftConfiguration = configurationFromDraft({ court, kind, sourceId, homeTeam, awayTeam, matchdayNumber,
    seasonLabel, scheduledAt, privacyStatus, description, recordingDirectory });

  const saveConfiguration = async () => {
    if (pending || active || homeTeam === awayTeam) return false;
    setSaving(true);
    const saved = await pilot.configure(inputFromDraft(draftConfiguration));
    setSaving(false);
    return saved;
  };

  return <article className="production-wizard__court" aria-labelledby={`wizard-court-${court.slug}`}>
    <header className="production-wizard__court-header">
      <div><span className="production-court-card__slug">{court.slug}</span><h3 ref={headingRef} tabIndex={-1} id={`wizard-court-${court.slug}`}>{court.name}</h3></div>
      <ol className="production-wizard__steps" aria-label={`Progreso de ${court.name}`}>
        {STEPS.map((candidate, index) => <li key={candidate.id} aria-current={candidate.id === step ? 'step' : undefined}
          className={index < stepIndex ? 'is-complete' : ''}>
          <span>{index < stepIndex ? <Check aria-hidden="true" /> : index + 1}</span><strong>{candidate.label}</strong>
        </li>)}
      </ol>
    </header>
    {step === 'match' ? <MatchStep court={court} kind={kind} teams={ready.teams} active={active}
      homeTeam={homeTeam} awayTeam={awayTeam} scheduledAt={scheduledAt} privacyStatus={privacyStatus} description={description}
      onHomeTeam={setHomeTeam} onAwayTeam={setAwayTeam} onScheduledAt={setScheduledAt} onPrivacyStatus={setPrivacyStatus}
      onDescription={setDescription}
      onBack={onBackToSelection} onContinue={() => setStep('camera')} /> : null}
    {step === 'camera' ? <CameraStep court={court} ready={ready} sourceId={sourceId} setSourceId={setSourceId}
      mobileCamera={mobileCamera} connectUrl={connectUrl} active={active} pending={pending}
      onCreate={() => pilot.createMobileCamera(court.slug)} onUpdate={pilot.updateMobileCamera} onRevoke={pilot.revokeMobileCamera}
      onBack={() => setStep('match')} onContinue={async () => { if (await saveConfiguration()) setStep('view'); }} error={error} /> : null}
    {step === 'view' ? <ViewStep court={court} configuration={draftConfiguration} mobileCamera={mobileCamera}
      onBack={() => setStep('camera')} onContinue={() => setStep('operator')} /> : null}
    {step === 'operator' ? <OperatorStep court={court} configuration={draftConfiguration} mobileCamera={mobileCamera}
      onBack={() => setStep('view')} onFinish={onFinish} nextCourtName={nextCourtName} /> : null}
  </article>;
}

function MatchStep({ court, kind, teams, active, homeTeam, awayTeam, scheduledAt,
  privacyStatus, description, onHomeTeam, onAwayTeam,
  onScheduledAt, onPrivacyStatus, onDescription, onBack, onContinue }: {
  readonly court: ProductionCourtSlot; readonly kind: ProductionKind; readonly teams: readonly Team[]; readonly active: boolean;
  readonly homeTeam: string; readonly awayTeam: string;
  readonly scheduledAt: string; readonly privacyStatus: PilotPrivacy; readonly description: string;
  readonly onHomeTeam: (value: string) => void; readonly onAwayTeam: (value: string) => void;
  readonly onScheduledAt: (value: string) => void; readonly onPrivacyStatus: (value: PilotPrivacy) => void;
  readonly onDescription: (value: string) => void;
  readonly onBack: () => void; readonly onContinue: () => void;
}) {
  const duplicateTeams = homeTeam !== '' && homeTeam === awayTeam;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!duplicateTeams) onContinue(); };
  return <form className="production-wizard__step" onSubmit={submit}>
    <div className="production-wizard__step-heading"><span><MonitorPlay aria-hidden="true" /></span>
      <div><h4>¿Qué partido se juega en {court.name}?</h4><p>Estos datos aparecerán en el marcador y en el archivo final.</p></div></div>
    {active ? <p className="production-command-feedback danger" role="alert">Esta pista tiene una sesión activa. Deténla antes de cambiar su configuración.</p> : null}
    <div className="production-wizard__teams">
      <label>Equipo local<select required value={homeTeam} onChange={(event) => onHomeTeam(event.currentTarget.value)}>
        {teams.map((team) => <option key={team.id} value={team.name}>{team.name}</option>)}</select></label>
      <strong aria-hidden="true">VS</strong>
      <label>Equipo visitante<select required value={awayTeam} onChange={(event) => onAwayTeam(event.currentTarget.value)}>
        {teams.map((team) => <option key={team.id} value={team.name}>{team.name}</option>)}</select></label>
    </div>
    {duplicateTeams ? <p className="production-command-feedback danger" role="alert">Selecciona dos equipos diferentes.</p> : null}
    <div className="production-wizard__fields">
      <label>Fecha y hora<input type="datetime-local" required min={kind === 'youtube' ? toLocalDateTime() : undefined}
        value={scheduledAt} onChange={(event) => onScheduledAt(event.currentTarget.value)} /></label>
      {kind === 'youtube' ? <label>Visibilidad<select value={privacyStatus}
        onChange={(event) => onPrivacyStatus(event.currentTarget.value as PilotPrivacy)}>
        <option value="private">Privado</option><option value="unlisted">No listado</option><option value="public">Público</option>
      </select></label> : null}
    </div>
    {kind === 'youtube' ? <label className="production-wizard__description">Descripción de YouTube<textarea required maxLength={5_000} value={description}
        onChange={(event) => onDescription(event.currentTarget.value)} /></label> : null}
    <WizardFooter onBack={onBack} backLabel="Elegir pistas"><button className="production-setup-submit" type="submit"
      disabled={active || duplicateTeams}>Continuar a Cámara<ArrowRight aria-hidden="true" /></button></WizardFooter>
  </form>;
}

function CameraStep({ court, ready, sourceId, setSourceId, mobileCamera, connectUrl, active, pending,
  onCreate, onUpdate, onRevoke, onBack, onContinue, error }: {
  readonly court: ProductionCourtSlot; readonly ready: ReadyPilotState; readonly sourceId: string;
  readonly setSourceId: (value: string) => void; readonly mobileCamera: PilotMobileCameraSession | null;
  readonly connectUrl: string | null; readonly active: boolean; readonly pending: boolean;
  readonly onCreate: () => Promise<unknown>; readonly onUpdate: ProductionPilotController['updateMobileCamera'];
  readonly onRevoke: ProductionPilotController['revokeMobileCamera']; readonly onBack: () => void;
  readonly onContinue: () => Promise<void>; readonly error: string | null;
}) {
  const mobileAvailable = ready.readiness.sources.some(({ id }) => id === PILOT_MOBILE_SOURCE_ID);
  const localSources = ready.readiness.sources.filter(({ id }) => id !== PILOT_MOBILE_SOURCE_ID);
  const mobileSelected = sourceId === PILOT_MOBILE_SOURCE_ID;
  const cameraReady = !mobileSelected || mobileCamera?.state === 'ready' || mobileCamera?.state === 'degraded';
  return <section className="production-wizard__step">
    <div className="production-wizard__step-heading"><span><Camera aria-hidden="true" /></span>
      <div><h4>¿Cómo recibirás la imagen?</h4><p>Elige la opción más sencilla para esta pista. Comprobaremos la señal antes de continuar.</p></div></div>
    <div className="production-wizard__source-options" role="radiogroup" aria-label="Origen de cámara">
      <button type="button" role="radio" aria-checked={mobileSelected} disabled={!mobileAvailable || active}
        onClick={() => setSourceId(PILOT_MOBILE_SOURCE_ID)}><Smartphone aria-hidden="true" /><span><strong>Conectar un móvil</strong>
          <small>Genera un enlace y acepta cámara y micrófono.</small></span><em>Más sencillo</em></button>
      <button type="button" role="radio" aria-checked={!mobileSelected} disabled={localSources.length === 0 || active}
        onClick={() => setSourceId(localSources[0]?.id ?? sourceId)}><Video aria-hidden="true" /><span><strong>Usar cámara del PC</strong>
          <small>Selecciona una cámara conectada a este equipo.</small></span></button>
    </div>
    {mobileSelected ? <PilotMobileCameraPanel courtSlug={court.slug} mobileCamera={mobileCamera} connectUrl={connectUrl}
      active={active} pending={pending} guided onCreate={onCreate} onUpdate={onUpdate} onRevoke={onRevoke} />
      : <div className="production-wizard__local-camera"><label>Cámara disponible<select value={sourceId}
        onChange={(event) => setSourceId(event.currentTarget.value)}>
        {localSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>
        <p><Check aria-hidden="true" />La imagen y el audio se comprobarán antes de iniciar la grabación.</p></div>}
    {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
    <WizardFooter onBack={onBack}><button className="production-setup-submit" type="button" disabled={!cameraReady || pending || active}
      onClick={() => void onContinue()}>{pending ? 'Guardando…' : 'Continuar a Vista'}<ArrowRight aria-hidden="true" /></button></WizardFooter>
  </section>;
}

function ViewStep({ court, configuration, mobileCamera, onBack, onContinue }: {
  readonly court: ProductionCourtSlot; readonly configuration: PilotConfiguration;
  readonly mobileCamera: PilotMobileCameraSession | null; readonly onBack: () => void; readonly onContinue: () => void;
}) {
  const match = useMatchSocket(court.slug, 'control', '');
  const settings = match.state?.overlaySettings ?? DEFAULT_OVERLAY_SETTINGS;
  const mobileSelected = configuration.sourceId === PILOT_MOBILE_SOURCE_ID;
  const mobileReady = mobileCamera?.state === 'ready' || mobileCamera?.state === 'degraded';
  const positions: readonly { readonly value: OverlayPosition; readonly label: string }[] = [
    { value: 'top-left', label: 'Lateral' }, { value: 'center', label: 'Centro' }, { value: 'bottom-center', label: 'Inferior' },
  ];
  const preview = <div className="production-wizard__overlay-frame">
    <iframe src={`/overlay/${encodeURIComponent(court.slug)}/scoreboard?preview=muted`} title={`Vista final de ${court.name}`} tabIndex={-1} />
  </div>;
  return <section className="production-wizard__step">
    <div className="production-wizard__step-heading"><span><Eye aria-hidden="true" /></span>
      <div><h4>Así quedará la grabación</h4><p>Comprueba el marcador y elige su posición viendo el resultado.</p></div></div>
    <div className="production-wizard__view-grid">
      <div className="production-wizard__program-preview">
        {mobileSelected && mobileCamera?.previewUrl
          ? <MobileCameraPreview url={mobileCamera.previewUrl} allowListening>{preview}</MobileCameraPreview>
          : <div className="production-wizard__preview-placeholder"><Camera aria-hidden="true" />
            <p>La cámara local se comprobará en el paso previo al inicio.</p>{preview}</div>}
        <div className="production-wizard__view-checks">
          <span className={!mobileSelected || mobileReady ? 'is-ready' : ''}>
            {!mobileSelected || mobileReady ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            {mobileSelected ? mobileReady ? 'Imagen recibida' : 'Esperando imagen' : 'Fuente seleccionada'}
          </span>
          <span><Circle aria-hidden="true" />Audio pendiente de prueba</span>
          <span className={match.state ? 'is-ready' : ''}>{match.state ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            {match.state ? 'Marcador conectado' : 'Conectando marcador'}</span>
        </div>
      </div>
      <aside className="production-wizard__view-controls" aria-label="Ajustes de vista">
        <h5>Elementos en pantalla</h5>
        <button type="button" className={settings.visible ? 'is-on' : ''} aria-pressed={settings.visible}
          disabled={!match.state || match.pending} onClick={() => void match.updateOverlaySettings({ visible: !settings.visible })}>
          {settings.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}<span><strong>Marcador</strong><small>{settings.visible ? 'Visible' : 'Oculto'}</small></span>
        </button>
        <fieldset><legend>Posición del marcador</legend><div className="production-wizard__positions">
          {positions.map((position) => <button key={position.value} type="button" aria-pressed={settings.position === position.value}
            disabled={!match.state || match.pending} onClick={() => void match.updateOverlaySettings({ position: position.value })}>
            <span className={`position-${position.value}`} aria-hidden="true" />{position.label}</button>)}
        </div></fieldset>
        <p>Los cambios del operador aparecerán aquí y en el MP4.</p>
        {match.error ? <p className="production-command-feedback danger" role="alert">{match.error}</p> : null}
      </aside>
    </div>
    <WizardFooter onBack={onBack}><button className="production-setup-submit" type="button" onClick={onContinue}>
      Continuar a Operador<ArrowRight aria-hidden="true" /></button></WizardFooter>
  </section>;
}

function OperatorStep({ court, configuration, mobileCamera, onBack, onFinish, nextCourtName }: {
  readonly court: ProductionCourtSlot; readonly configuration: PilotConfiguration;
  readonly mobileCamera: PilotMobileCameraSession | null; readonly onBack: () => void;
  readonly onFinish: () => void; readonly nextCourtName: string | null;
}) {
  const [operatorLinkReady, setOperatorLinkReady] = useState(false);
  const cameraReady = configuration.sourceId !== PILOT_MOBILE_SOURCE_ID
    || mobileCamera?.state === 'ready' || mobileCamera?.state === 'degraded';
  return <section className="production-wizard__step">
    <div className="production-wizard__step-heading"><span><Smartphone aria-hidden="true" /></span>
      <div><h4>Control del operador</h4><p>Este enlace solo permite usar el marcador y cambiar la vista de {court.name}.</p></div></div>
    <div className="production-wizard__operator-grid">
      <ScorerAccess courtSlug={court.slug} seasonLabel={configuration.seasonLabel}
        matchdayNumber={configuration.matchdayNumber} expanded variant="wizard" onLinkCreated={setOperatorLinkReady} />
      <aside className="production-wizard__verification"><h5>Comprobar acceso</h5>
        <p>Abre el enlace en el móvil del operador y verifica que todo funciona.</p>
        <ul><li className="is-ready"><Check aria-hidden="true" />Configuración guardada</li>
          <li className={cameraReady ? 'is-ready' : ''}>{cameraReady ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            {configuration.sourceId === PILOT_MOBILE_SOURCE_ID ? cameraReady ? 'Cámara conectada' : 'Cámara pendiente' : 'Fuente de cámara seleccionada'}</li>
          <li className={operatorLinkReady ? 'is-ready' : ''}>{operatorLinkReady ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            {operatorLinkReady ? 'Enlace de operador generado' : 'Genera el enlace del operador'}</li></ul>
        <strong className={operatorLinkReady ? 'is-ready' : ''}>{operatorLinkReady ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
          {operatorLinkReady ? `${court.name} configurada` : 'Falta generar el acceso del operador'}</strong>
      </aside>
    </div>
    <WizardFooter onBack={onBack}><button className="production-setup-submit" type="button" disabled={!operatorLinkReady} onClick={onFinish}>
      {nextCourtName ? `Guardar y configurar ${nextCourtName}` : 'Guardar y volver a Producción'}<ArrowRight aria-hidden="true" /></button></WizardFooter>
  </section>;
}

function WizardFooter({ onBack, backLabel = 'Atrás', children }: {
  readonly onBack: () => void; readonly backLabel?: string; readonly children: ReactNode;
}) {
  return <footer className="production-wizard__footer"><button type="button" className="refresh-button" onClick={onBack}>
    <ArrowLeft aria-hidden="true" />{backLabel}</button>{children}</footer>;
}

function configurationFromDraft(values: {
  readonly court: ProductionCourtSlot; readonly kind: ProductionKind; readonly sourceId: string;
  readonly homeTeam: string; readonly awayTeam: string; readonly matchdayNumber: number; readonly seasonLabel: string;
  readonly scheduledAt: string; readonly privacyStatus: PilotPrivacy; readonly description: string; readonly recordingDirectory: string;
}): PilotConfiguration {
  const parsedSchedule = new Date(values.scheduledAt);
  const scheduledAt = Number.isNaN(parsedSchedule.getTime()) ? new Date().toISOString() : parsedSchedule.toISOString();
  return {
    courtSlug: values.court.slug, mode: values.kind, sourceId: values.sourceId,
    homeTeam: values.homeTeam, awayTeam: values.awayTeam, matchdayNumber: values.matchdayNumber,
    seasonLabel: values.seasonLabel, scheduledAt,
    privacyStatus: values.kind === 'recording' ? 'private' : values.privacyStatus,
    ...(values.kind === 'youtube' ? { description: values.description } : {}),
    ...(values.recordingDirectory.trim() ? { recordingDirectory: values.recordingDirectory.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function inputFromDraft(configuration: PilotConfiguration): PreparePilotSessionInput {
  const { updatedAt, ...input } = configuration;
  void updatedAt;
  return input;
}

function teamName(teams: readonly Team[], teamId: string | undefined, fallbackIndex: number): string {
  return teams.find((team) => team.id === teamId)?.name ?? teams[fallbackIndex]?.name ?? teams[0]?.name ?? '';
}

function toLocalDateTime(value?: string): string {
  const candidate = value ? new Date(value) : new Date(Date.now() + 10 * 60_000);
  const date = Number.isNaN(candidate.getTime()) ? new Date(Date.now() + 10 * 60_000) : candidate;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
