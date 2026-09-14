import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CircleCheck, CircleX, ExternalLink, Radio, RefreshCw, TestTube2 } from 'lucide-react';
import type {
  PilotCourtSlug,
  PilotMode,
  PilotPrivacy,
  PilotReadiness,
  PilotSession,
  PreparePilotSessionInput,
} from '@kpl/production-contracts';
import { useProductionPilot } from '../hooks/useProductionPilot.js';

const COURTS: readonly { readonly slug: PilotCourtSlug; readonly label: string; readonly home: string; readonly away: string }[] = [
  { slug: 'pista-1', label: 'Pista 1', home: 'Red Lions', away: 'Kings' },
  { slug: 'pista-2', label: 'Pista 2', home: 'Vipers', away: 'Titans' },
  { slug: 'pista-3', label: 'Pista 3', home: 'Warriors', away: 'Legends' },
];

export function ProductionPilotWorkspace({ onBack }: { readonly onBack: () => void }) {
  const pilot = useProductionPilot();
  const [elapsedByCourt, setElapsedByCourt] = useState<Partial<Record<PilotCourtSlug, number>>>({});
  const recordElapsed = useCallback((court: PilotCourtSlug, seconds: number | null) => {
    setElapsedByCourt((current) => ({ ...current, [court]: seconds ?? undefined }));
  }, []);

  if (pilot.state.kind === 'loading') return <PilotShell onBack={onBack}><p>Cargando diagnóstico del PC…</p></PilotShell>;
  if (pilot.state.kind === 'error') return (
    <PilotShell onBack={onBack}>
      <div className="production-page-feedback danger" role="alert">
        <p>{pilot.state.message}</p>
        <button type="button" className="refresh-button" onClick={() => void pilot.refresh()}>Reintentar</button>
      </div>
    </PilotShell>
  );

  const ready = pilot.state;
  const sessions = COURTS.map(({ slug }) => latestSession(ready.sessions, slug));
  const unavailableSources = new Set(ready.sessions
    .filter((session) => session.source.kind === 'v4l2' && !['stopped', 'failed'].includes(session.status))
    .map((session) => session.source.id));
  const activeCount = sessions.filter((session) => session && ['starting', 'live', 'stopping'].includes(session.status)).length;

  return (
    <PilotShell onBack={onBack}>
      <section className="production-pilot-intro" aria-labelledby="pilot-title">
        <div><p className="production-kicker">Control central · tres salidas</p><h1 id="pilot-title">Centro de emisiones</h1>
          <p>Prepara y controla cada pista por separado. El modo simulación codifica de verdad sin crear contenido externo.</p></div>
        <ReadinessSummary readiness={ready.readiness} activeCount={activeCount} />
      </section>

      {ready.error ? <div className="production-page-feedback danger" role="alert">{ready.error}</div> : null}

      <section className="production-pilot-courts" aria-label="Emisiones por pista">
        {COURTS.map((court) => (
          <PilotCourtPanel
            key={court.slug}
            court={court}
            readiness={ready.readiness}
            session={latestSession(ready.sessions, court.slug)}
            pending={ready.pendingCourts.includes(court.slug)}
            error={ready.courtErrors[court.slug] ?? null}
            unavailableSources={unavailableSources}
            onPrepare={(input) => void pilot.prepare(input)}
            onStart={(session) => void pilot.start(session)}
            onStop={(session) => void pilot.stop(session)}
            onElapsed={recordElapsed}
          />
        ))}
      </section>

      <ValidationDecision readiness={ready.readiness} sessions={sessions} elapsedByCourt={elapsedByCourt} />
    </PilotShell>
  );
}

function PilotCourtPanel({
  court, readiness, session, pending, error, unavailableSources, onPrepare, onStart, onStop, onElapsed,
}: {
  readonly court: (typeof COURTS)[number];
  readonly readiness: PilotReadiness;
  readonly session: PilotSession | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly unavailableSources: ReadonlySet<string>;
  readonly onPrepare: (input: PreparePilotSessionInput) => void;
  readonly onStart: (session: PilotSession) => void;
  readonly onStop: (session: PilotSession) => void;
  readonly onElapsed: (court: PilotCourtSlug, seconds: number | null) => void;
}) {
  const [mode, setMode] = useState<PilotMode>('simulation');
  const [homeTeam, setHomeTeam] = useState(court.home);
  const [awayTeam, setAwayTeam] = useState(court.away);
  const [seasonLabel, setSeasonLabel] = useState('T2');
  const [matchdayNumber, setMatchdayNumber] = useState(1);
  const [scheduledAt, setScheduledAt] = useState(defaultScheduledAt);
  const [privacyStatus, setPrivacyStatus] = useState<PilotPrivacy>('private');
  const [sourceId, setSourceId] = useState('synthetic');
  const attemptStartedAt = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (session?.status !== 'live' || elapsedSeconds !== null || attemptStartedAt.current === null) return;
    const elapsed = Math.round((performance.now() - attemptStartedAt.current) / 1_000);
    setElapsedSeconds(elapsed);
    onElapsed(court.slug, elapsed);
  }, [court.slug, elapsedSeconds, onElapsed, session?.status]);

  const canPrepare = session === null || ['stopped', 'failed'].includes(session.status);
  const youtubeUnavailable = mode === 'youtube' && !readiness.youtube.authorized;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (youtubeUnavailable || !canPrepare) return;
    attemptStartedAt.current = performance.now();
    setElapsedSeconds(null);
    onElapsed(court.slug, null);
    onPrepare({
      courtSlug: court.slug, mode, sourceId, homeTeam, awayTeam, matchdayNumber, seasonLabel,
      scheduledAt: new Date(scheduledAt).toISOString(), privacyStatus,
    });
  };
  const start = () => {
    if (session === null) return;
    if (session.mode === 'youtube'
      && !window.confirm(`Se iniciará una emisión real de ${court.label} en YouTube. ¿Continuar?`)) return;
    if (attemptStartedAt.current === null) attemptStartedAt.current = performance.now();
    onStart(session);
  };

  return (
    <article className="production-pilot-court" aria-labelledby={`pilot-title-${court.slug}`}>
      <header className="production-pilot-court__header">
        <div><span className="production-court-card__slug">{court.slug}</span><h2 id={`pilot-title-${court.slug}`}>{court.label}</h2></div>
        <CourtStatus session={session} />
      </header>

      <form className="production-pilot-form" onSubmit={submit}>
        <fieldset disabled={!canPrepare || pending}>
          <legend>Preparación</legend>
          <div className="production-pilot-mode">
            <label><input type="radio" name={`pilot-mode-${court.slug}`} checked={mode === 'simulation'} onChange={() => setMode('simulation')} />
              <span><TestTube2 aria-hidden="true" /><strong>Simulación</strong><small>Solo en este PC.</small></span></label>
            <label><input type="radio" name={`pilot-mode-${court.slug}`} checked={mode === 'youtube'} onChange={() => setMode('youtube')} />
              <span><Radio aria-hidden="true" /><strong>YouTube</strong><small>Emisión real.</small></span></label>
          </div>
          {youtubeUnavailable ? <p className="production-command-feedback danger">La cuenta de YouTube no está conectada.</p> : null}
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
          <button className="production-setup-submit" type="submit" disabled={youtubeUnavailable || !canPrepare || pending}>
            {pending ? 'Procesando…' : mode === 'youtube' ? 'Crear en YouTube' : 'Preparar señal'}
          </button>
        </fieldset>
      </form>

      <div className="production-pilot-output">
        {session === null
          ? <p className="production-pilot-empty">Todavía no hay una emisión preparada.</p>
          : <PilotSessionCard session={session} pending={pending} elapsedSeconds={elapsedSeconds}
            onStart={start} onStop={() => onStop(session)} />}
        {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
      </div>
    </article>
  );
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
  return (
    <div className="production-pilot-session">
      <div className="production-pilot-thumbnail"><img src={session.thumbnailUrl} alt={`Miniatura de ${session.title}`} /></div>
      <div className="production-pilot-session__copy">
        <h3>{session.title}</h3><p>{session.source.label} · {session.mode === 'youtube' ? 'YouTube' : 'Salida local'}</p>
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
    </div>
  );
}

function ReadinessSummary({ readiness, activeCount }: { readonly readiness: PilotReadiness; readonly activeCount: number }) {
  return <aside className="production-pilot-readiness"><h2>Este PC</h2>
    <p>{readiness.ffmpeg.available ? '✓ FFmpeg disponible' : '✕ FFmpeg no disponible'}</p>
    <p><strong>{activeCount}/3</strong> salidas activas</p>
    <p>{readiness.sources.filter(({ kind }) => kind === 'v4l2').length} cámaras detectadas</p>
    <p>{readiness.youtube.authorized ? '✓ YouTube conectado' : 'YouTube pendiente'}</p>
    {!readiness.youtube.authorized && readiness.youtube.configured && readiness.youtube.authorizationUrl
      ? <a className="production-setup-submit" href={readiness.youtube.authorizationUrl}>Conectar YouTube</a>
      : null}
    {readiness.limitations.map((limitation) => <small key={limitation}>{limitation}</small>)}</aside>;
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
  const decision = youtubeHealthy === 3
    ? 'Tres emisiones reales validadas'
    : stable === 3 ? 'Tres motores locales validados; falta la prueba triple en YouTube' : 'Validación de tres pistas en curso';
  return <section className="production-pilot-decision" aria-labelledby="pilot-decision-title">
    <div><p className="production-kicker">Decisión con evidencia</p><h2 id="pilot-decision-title">{decision}</h2>
      <p>Primero ejecuta las tres en simulación. Solo después crea tres pruebas privadas en YouTube.</p></div>
    <ul>
      <li className={readiness.ffmpeg.available ? 'passed' : ''}>FFmpeg disponible</li>
      <li className={prepared === 3 ? 'passed' : ''}>Metadatos preparados: {prepared}/3</li>
      <li className={stable === 3 ? 'passed' : ''}>Codificación estable: {stable}/3</li>
      <li className={youtubeHealthy === 3 ? 'passed' : ''}>YouTube activo y saludable: {youtubeHealthy}/3</li>
      <li className={underTwoMinutes === 3 ? 'passed' : ''}>Preparación menor de 2 minutos: {underTwoMinutes}/3</li>
    </ul>
  </section>;
}

function PilotShell({ children, onBack }: { readonly children: ReactNode; readonly onBack: () => void }) {
  return <main className="home-page production-overview-page production-pilot-page">
    <header className="home-topbar production-overview-topbar"><div className="brand"><img src="/logos/kpl-wordmark.png" alt="" width="144" height="54" />
      <span><strong>KPL Control Center</strong><small>Control local de emisiones</small></span></div>
      <button type="button" className="refresh-button" onClick={onBack}><ArrowLeft aria-hidden="true" />Volver</button></header>
    {children}
  </main>;
}

function latestSession(sessions: readonly PilotSession[], courtSlug: PilotCourtSlug): PilotSession | null {
  return [...sessions].filter((session) => session.courtSlug === courtSlug).at(-1) ?? null;
}

function defaultScheduledAt(): string {
  const date = new Date(Date.now() + 10 * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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
