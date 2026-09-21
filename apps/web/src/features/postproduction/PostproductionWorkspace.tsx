import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, CircleAlert, Film, FolderOpen, Pause, Play, RefreshCw, Save, Scissors, Sparkles, Square, X } from 'lucide-react';
import {
  type JsonValue,
  type PostproductionAction,
  type PostproductionActionKind,
  type PostproductionProject,
  type PostproductionSourceListing,
} from '@kpl/production-contracts';
import {
  applyMatchAction, createInitialMatchState, formatPoint, getCompletedSetCount,
  type MatchState, type Side, type Team,
} from '@kpl/shared';
import { createProductionPilotAdapter } from '../production/production-pilot-adapter.js';
import { fetchLeagueSnapshot } from '../../lib/league-data.js';
import { MATCH_CARDS } from '../../lib/match-cards.js';
import { SPONSORS } from '../../lib/sponsors.js';
import { Scoreboard } from '../match-display/Scoreboard.js';

const adapter = createProductionPilotAdapter();

export function PostproductionWorkspace() {
  const [projects, setProjects] = useState<readonly PostproductionProject[]>([]);
  const [teams, setTeams] = useState<readonly Team[]>([]);
  const [selected, setSelected] = useState<PostproductionProject | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [projectResult, teamResult] = await Promise.all([adapter.postproductionProjects(), adapter.teams()]);
    if (projectResult.kind === 'error') { setError(projectResult.message); setLoading(false); return; }
    setProjects(projectResult.value.projects);
    if (teamResult.kind === 'success') setTeams(teamResult.value);
    setSelected((current) => current ? projectResult.value.projects.find(({ id }) => id === current.id) ?? current : null);
    setLoading(false); setError(null);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => adapter.subscribeToEvents(({ scope }) => { if (scope === 'postproduction') void load(); }), [load]);

  if (selected) return <PostproductionEditor key={`${selected.id}:${selected.revision}`} project={selected}
    teams={(selected.teams as unknown as Team[]) || [...teams]} onClose={() => { setSelected(null); void load(); }} onProject={setSelected} />;

  return <section className="postproduction-workspace" aria-labelledby="postproduction-title">
    <header className="postproduction-heading">
      <div><p className="production-kicker">Postproducción local</p><h2 id="postproduction-title">Renovar partidos</h2>
        <p>Añade el layout KPL a un MP4 de la carpeta montada y continúa otro día desde el último checkpoint.</p></div>
      <button type="button" className="production-setup-submit" onClick={() => setCreating(true)}><Sparkles aria-hidden="true" />Nueva renovación</button>
    </header>
    {error ? <div className="production-page-feedback danger" role="alert"><CircleAlert aria-hidden="true" />{error}
      <button type="button" className="refresh-button" onClick={() => void load()}><RefreshCw aria-hidden="true" />Reintentar</button></div> : null}
    {creating ? <CreateProject teams={teams} onCancel={() => setCreating(false)} onCreated={(project) => { setCreating(false); setSelected(project); }} /> : null}
    {loading ? <p aria-busy="true">Cargando proyectos de renovación…</p> : null}
    {!loading && projects.length === 0 && !creating ? <div className="production-pilot-empty-state"><Film aria-hidden="true" />
      <h3>No hay renovaciones</h3><p>Crea un proyecto para comenzar a contar un partido grabado.</p></div> : null}
    <div className="postproduction-project-grid">
      {projects.map((project) => <article className="postproduction-project-card" key={project.id}>
        <header><div><span className="production-court-card__slug">{project.courtSlug}</span><h3>{project.title}</h3></div>
          <span className={`production-status ${project.status === 'ready' ? 'success' : project.status === 'failed' ? 'danger' : 'info'}`}>{projectStatus(project)}</span></header>
        <dl><div><dt>Fuente</dt><dd>{project.source.name}</dd></div><div><dt>Checkpoint</dt><dd>{duration(project.checkpoint.playheadMs / 1_000)}</dd></div>
          <div><dt>Progreso</dt><dd>{project.render ? `${Math.round(project.render.progress * 100)}%` : 'Sin render'}</dd></div></dl>
        {project.render?.error ? <p className="production-command-feedback danger">{project.render.error}</p> : null}
        <button type="button" className="refresh-button" onClick={() => setSelected(project)}>
          {project.status === 'rendering' ? 'Ver progreso' : project.status === 'ready' ? 'Abrir proyecto' : 'Continuar renovación'}</button>
      </article>)}
    </div>
  </section>;
}

function CreateProject({ teams, onCancel, onCreated }: {
  readonly teams: readonly Team[]; readonly onCancel: () => void; readonly onCreated: (project: PostproductionProject) => void;
}) {
  const [listing, setListing] = useState<PostproductionSourceListing | null>(null);
  const [sourcePath, setSourcePath] = useState('');
  const [title, setTitle] = useState('');
  const [seasonLabel, setSeasonLabel] = useState('Temporada actual');
  const [matchdayNumber, setMatchdayNumber] = useState(1);
  const [courtSlug, setCourtSlug] = useState('pista-1');
  const [homeTeamId, setHomeTeamId] = useState(teams[0]?.id ?? 'home');
  const [awayTeamId, setAwayTeamId] = useState(teams[1]?.id ?? 'away');
  const [homePlayers, setHomePlayers] = useState(['', '']);
  const [awayPlayers, setAwayPlayers] = useState(['', '']);
  const [servingSide, setServingSide] = useState<Side>('home');
  const [deuceMode, setDeuceMode] = useState<'golden-point' | 'advantage'>('golden-point');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browse = async (path?: string) => {
    const result = await adapter.postproductionSources(path);
    if (result.kind === 'error') setError(result.message); else { setListing(result.value); setError(null); }
  };
  useEffect(() => { void browse(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setPending(true); setError(null);
    const initialState = createInitialMatchState({
      id: `postproduction-${crypto.randomUUID()}`, title, homeTeamId, awayTeamId,
      lineups: { home: { player1: homePlayers[0] ?? '', player2: homePlayers[1] ?? '' },
        away: { player1: awayPlayers[0] ?? '', player2: awayPlayers[1] ?? '' } },
      servingSide, courtName: courtSlug.replaceAll('-', ' '), status: 'live',
      config: { setsToWin: 2, gamesPerSet: 6, tieBreakAt: 6, tieBreakTarget: 7, tieBreakWinBy: 2, deuceMode },
    });
    const leagueSnapshot = await fetchLeagueSnapshot([...teams]).catch(() => null);
    const result = await adapter.createPostproductionProject({
      sourcePath, title, seasonLabel, matchdayNumber, courtSlug: courtSlug as never,
      initialState: initialState as unknown as JsonValue, teams: teams as unknown as JsonValue,
      leagueSnapshot: leagueSnapshot as unknown as JsonValue,
    });
    setPending(false);
    if (result.kind === 'error') setError(result.message); else onCreated(result.value.project);
  };

  return <form className="postproduction-create" onSubmit={(event) => void submit(event)}>
    <header><div><p className="production-kicker">Nuevo proyecto</p><h3>Selecciona vídeo y partido</h3></div>
      <button type="button" className="refresh-button" onClick={onCancel} aria-label="Cerrar"><X aria-hidden="true" /></button></header>
    <section className="postproduction-source-picker" aria-label="Vídeos disponibles">
      <div className="postproduction-source-toolbar"><code>/{listing?.current ?? ''}</code>
        <button type="button" disabled={!listing?.parent} onClick={() => void browse(listing?.parent ?? undefined)}>Subir</button></div>
      <div className="postproduction-source-list">
        {listing?.directories.map((directory) => <button type="button" key={directory.path} onClick={() => void browse(directory.path)}><FolderOpen aria-hidden="true" />{directory.name}</button>)}
        {listing?.files.map((file) => <button type="button" className={sourcePath === file.path ? 'selected' : ''} key={file.path} onClick={() => { setSourcePath(file.path); if (!title) setTitle(file.name.replace(/\.mp4$/i, '')); }}>
          <Film aria-hidden="true" />{file.name}<small>{bytes(file.sizeBytes)}</small></button>)}
      </div>
      {sourcePath ? <p>Seleccionado: <strong>{sourcePath}</strong></p> : null}
    </section>
    <div className="postproduction-form-grid">
      <label>Título<input required value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label>Temporada<input required value={seasonLabel} onChange={(event) => setSeasonLabel(event.currentTarget.value)} /></label>
      <label>Jornada<input required type="number" min="1" max="999" value={matchdayNumber} onChange={(event) => setMatchdayNumber(Number(event.currentTarget.value))} /></label>
      <label>Pista<input required pattern="pista-[a-z0-9-]+" value={courtSlug} onChange={(event) => setCourtSlug(event.currentTarget.value)} /></label>
      <label>Equipo local<select value={homeTeamId} onChange={(event) => setHomeTeamId(event.currentTarget.value)}>{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>
      <label>Equipo visitante<select value={awayTeamId} onChange={(event) => setAwayTeamId(event.currentTarget.value)}>{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>
      <label>Jugadores local<input placeholder="Jugador 1 / Jugador 2" value={homePlayers.join(' / ')} onChange={(event) => setHomePlayers(splitPlayers(event.currentTarget.value))} /></label>
      <label>Jugadores visitante<input placeholder="Jugador 1 / Jugador 2" value={awayPlayers.join(' / ')} onChange={(event) => setAwayPlayers(splitPlayers(event.currentTarget.value))} /></label>
      <label>Saque inicial<select value={servingSide} onChange={(event) => setServingSide(event.currentTarget.value as Side)}><option value="home">Local</option><option value="away">Visitante</option></select></label>
      <label>Modo 40–40<select value={deuceMode} onChange={(event) => setDeuceMode(event.currentTarget.value as 'golden-point' | 'advantage')}><option value="golden-point">Punto de oro</option><option value="advantage">Ventaja</option></select></label>
    </div>
    {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
    <footer><button type="button" className="refresh-button" onClick={onCancel}>Cancelar</button>
      <button type="submit" className="production-setup-submit" disabled={!sourcePath || pending || homeTeamId === awayTeamId}>{pending ? 'Validando MP4…' : 'Crear renovación'}</button></footer>
  </form>;
}

function PostproductionEditor({ project: initialProject, teams, onClose, onProject }: {
  readonly project: PostproductionProject; readonly teams: Team[]; readonly onClose: () => void;
  readonly onProject: (project: PostproductionProject) => void;
}) {
  const [project, setProject] = useState(initialProject);
  const [actions, setActions] = useState<PostproductionAction[]>([...initialProject.checkpoint.actions]);
  const [state, setState] = useState(initialProject.checkpoint.state as unknown as MatchState);
  const [playheadMs, setPlayheadMs] = useState(initialProject.checkpoint.playheadMs);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relinking, setRelinking] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastEventMs = actions.at(-1)?.timestampMs ?? 0;
  const atTip = playheadMs >= lastEventMs;
  const controlsDisabled = !atTip || pending || project.status === 'rendering';
  const activeSet = state.sets.find((set) => set.status === 'active') ?? state.sets.at(-1);

  useEffect(() => { void adapter.postproductionMediaUrl(project.id).then((result) => {
    if (result.kind === 'success') setMediaUrl(result.value); else setError(result.message);
  }); }, [project.id]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (project.status !== 'rendering') return undefined;
    const timer = window.setInterval(() => void adapter.postproductionProjects().then((result) => {
      if (result.kind !== 'success') return;
      const next = result.value.projects.find(({ id }) => id === project.id); if (next) { setProject(next); onProject(next); }
    }), 1_000);
    return () => window.clearInterval(timer);
  }, [onProject, project.id, project.status]);

  const persist = async (reason: 'game' | 'manual' | 'recount', nextActions = actions) => {
    setPending(true); setError(null);
    const result = await adapter.savePostproductionCheckpoint(project.id, {
      expectedRevision: project.revision, playheadMs, actions: nextActions, reason,
    });
    setPending(false);
    if (result.kind === 'error') { setError(result.message); return null; }
    setProject(result.value.project); onProject(result.value.project); setDirty(false); return result.value.project;
  };

  const command = (kind: PostproductionActionKind, payload: JsonValue) => {
    if (!atTip || pending || project.status === 'rendering') return;
    const action: PostproductionAction = { id: crypto.randomUUID(), timestampMs: Math.max(playheadMs, lastEventMs), kind, payload };
    try {
      const previousGames = gameCount(state);
      const nextState = applyMatchAction(state, action);
      const nextActions = [...actions, action];
      setState(nextState); setActions(nextActions); setDirty(true);
      if (gameCount(nextState) > previousGames) void persistWith(nextActions, 'game');
    } catch (commandError) { setError(commandError instanceof Error ? commandError.message : 'No se pudo aplicar la acción.'); }
  };
  const persistWith = async (nextActions: PostproductionAction[], reason: 'game' | 'recount', checkpointPlayheadMs = playheadMs) => {
    setPending(true);
    const result = await adapter.savePostproductionCheckpoint(project.id, { expectedRevision: project.revision, playheadMs: checkpointPlayheadMs, actions: nextActions, reason });
    setPending(false);
    if (result.kind === 'error') setError(result.message);
    else { setProject(result.value.project); onProject(result.value.project); setDirty(false); }
  };
  const recount = async (index: number) => {
    const action = actions[index]; if (!action || !window.confirm('Se eliminará esta acción y todas las posteriores. ¿Quieres recontar desde aquí?')) return;
    const nextActions = actions.slice(0, index);
    const nextState = nextActions.reduce((current, item) => applyMatchAction(current, item), project.initialState as unknown as MatchState);
    setActions(nextActions); setState(nextState); setPlayheadMs(action.timestampMs);
    if (videoRef.current) videoRef.current.currentTime = action.timestampMs / 1_000;
    await persistWith(nextActions, 'recount', action.timestampMs);
  };
  const startRender = async () => {
    let current = project;
    if (dirty) { const saved = await persist('manual'); if (!saved) return; current = saved; }
    setPending(true); const result = await adapter.renderPostproductionProject(current.id); setPending(false);
    if (result.kind === 'error') setError(result.message); else { setProject(result.value.project); onProject(result.value.project); }
  };

  const leave = () => { if (!dirty || window.confirm('Hay cambios sin guardar. ¿Quieres salir y volver al último checkpoint?')) onClose(); };

  return <section className="postproduction-editor" aria-labelledby="postproduction-editor-title">
    <header><button type="button" className="refresh-button" onClick={leave}><ArrowLeft aria-hidden="true" />Volver</button>
      <div><p className="production-kicker">Renovación · {project.courtSlug}</p><h2 id="postproduction-editor-title">{project.title}</h2></div>
      <div className="postproduction-save-status"><span>{dirty ? 'Cambios sin guardar' : `Guardado · ${duration(project.checkpoint.playheadMs / 1_000)}`}</span>
        <button type="button" className="refresh-button" disabled={project.status === 'rendering'} onClick={() => setRelinking((current) => !current)}><FolderOpen aria-hidden="true" />Reenlazar fuente</button>
        <button type="button" className="refresh-button" disabled={!dirty || pending} onClick={() => void persist('manual').then((saved) => { if (saved) onClose(); })}><Save aria-hidden="true" />Guardar y salir</button></div></header>
    {error ? <div className="production-page-feedback danger" role="alert"><CircleAlert aria-hidden="true" />{error}</div> : null}
    {relinking ? <RelinkSource project={project} onCancel={() => setRelinking(false)} onRelinked={(next) => { setRelinking(false); setProject(next); onProject(next); }} /> : null}
    <div className="postproduction-editor-layout">
      <section className="postproduction-stage" aria-label="Previsualización del vídeo renovado">
        {mediaUrl ? <video ref={videoRef} src={mediaUrl} controls preload="metadata"
          onLoadedMetadata={(event) => { event.currentTarget.currentTime = project.checkpoint.playheadMs / 1_000; }}
          onTimeUpdate={(event) => setPlayheadMs(Math.round(event.currentTarget.currentTime * 1_000))} /> : <p>Cargando vídeo…</p>}
        {state.overlaySettings.visible ? <div className={`postproduction-score-preview ${state.overlaySettings.position}`} data-size={state.overlaySettings.size}>
          <div className="broadcast-scoreboard-shell overlay-page"><Scoreboard state={state} teams={teams} mode="overlay" /></div></div> : null}
        {!atTip ? <div className="postproduction-past-warning"><Scissors aria-hidden="true" />Estás antes del último evento. Elige “Recontar desde aquí” en el historial para modificar esta zona.</div> : null}
      </section>
      <aside className="postproduction-controls">
        <section><h3>Marcador</h3><p className="postproduction-scoreline">{formatPoint(state, 'home')} — {formatPoint(state, 'away')}<small>Juegos {activeSet?.homeGames ?? 0}–{activeSet?.awayGames ?? 0} · Sets {getCompletedSetCount(state, 'home')}–{getCompletedSetCount(state, 'away')}</small></p>
          <div className="postproduction-point-buttons"><button type="button" disabled={controlsDisabled || state.status === 'finished'} onClick={() => command('add_point', { side: 'home' })}>+ Punto local</button>
            <button type="button" disabled={controlsDisabled || state.status === 'finished'} onClick={() => command('add_point', { side: 'away' })}>+ Punto visitante</button></div>
          <div className="postproduction-compact-actions"><button type="button" disabled={controlsDisabled} onClick={() => command('undo', {})}>Deshacer</button><button type="button" disabled={controlsDisabled} onClick={() => command('reset', {})}>Reset</button>
            <button type="button" disabled={controlsDisabled} onClick={() => command('set_status', { status: 'live' })}><Play aria-hidden="true" />Live</button><button type="button" disabled={controlsDisabled} onClick={() => command('set_status', { status: 'finished' })}><Square aria-hidden="true" />Final</button></div>
          <ManualCorrection state={state} disabled={controlsDisabled} onApply={(patch) => command('manual_patch', { patch } as unknown as JsonValue)} />
        </section>
        <section><h3>Layout</h3><div className="postproduction-form-grid">
          <label><input type="checkbox" disabled={controlsDisabled} checked={state.overlaySettings.visible} onChange={(event) => command('update_overlay', { patch: { visible: event.currentTarget.checked } })} /> Marcador visible</label>
          <label>Tamaño<select disabled={controlsDisabled} value={state.overlaySettings.size} onChange={(event) => command('update_overlay', { patch: { size: event.currentTarget.value } })}><option value="compact">Compacto</option><option value="standard">Estándar</option><option value="large">Grande</option></select></label>
          <label>Posición<select disabled={controlsDisabled} value={state.overlaySettings.position} onChange={(event) => command('update_overlay', { patch: { position: event.currentTarget.value } })}><option value="top-left">Arriba izquierda</option><option value="center">Centro</option><option value="bottom-center">Abajo centro</option></select></label>
          <label><input type="checkbox" disabled={controlsDisabled} checked={state.overlaySettings.soundEnabled} onChange={(event) => command('update_overlay', { patch: { soundEnabled: event.currentTarget.checked } })} /> Sonido de cartas</label>
        </div></section>
        <section><h3>Cartas</h3><div className="postproduction-chip-grid">{(['home', 'away'] as const).flatMap((side) => MATCH_CARDS.map((card) => <button type="button" key={`${side}-${card.id}`} disabled={controlsDisabled || Boolean(state.cards[side])} onClick={() => command('use_card', { side, cardId: card.id, cardName: card.name })}>{side === 'home' ? 'L' : 'V'} · {card.name}</button>))}</div></section>
        <section><h3>Escenas de datos</h3><div className="postproduction-chip-grid">{(['standings', 'player-ranking', 'team-roster', 'calendar', 'upcoming-matches', 'latest-results'] as const).map((kind) => <button type="button" disabled={controlsDisabled} key={kind} onClick={() => command('trigger_data_scene', { kind, target: kind === 'team-roster' ? { type: 'side', side: 'home' } : { type: 'league' } })}>{kind}</button>)}</div></section>
        <section><h3>Patrocinadores</h3><div className="postproduction-compact-actions"><button type="button" disabled={controlsDisabled} onClick={() => command('update_sponsor_ticker', { patch: { visible: !state.sponsorAds.ticker.visible, sponsorIds: SPONSORS.map(({ id }) => id) } })}>{state.sponsorAds.ticker.visible ? 'Ocultar ticker' : 'Mostrar ticker'}</button>
          <button type="button" disabled={controlsDisabled} onClick={() => command('trigger_sponsor_ad', { sponsorIds: SPONSORS.map(({ id }) => id), durationSeconds: 8 })}>Anuncio completo</button></div></section>
      </aside>
    </div>
    <section className="postproduction-timeline"><header><div><h3>Cronología</h3><p>{actions.length} acciones · playhead {duration(playheadMs / 1_000)}</p></div>
      {project.status === 'rendering' ? <button type="button" className="refresh-button" onClick={() => void adapter.cancelPostproductionRender(project.id)}><Pause aria-hidden="true" />Cancelar render</button>
        : <button type="button" className="production-setup-submit" disabled={pending || actions.length === 0} onClick={() => void startRender()}><Sparkles aria-hidden="true" />Generar MP4</button>}</header>
      {project.render ? <progress max="1" value={project.render.progress}>{Math.round(project.render.progress * 100)}%</progress> : null}
      <ol>{actions.map((action, index) => <li key={action.id}><button type="button" onClick={() => { setPlayheadMs(action.timestampMs); if (videoRef.current) videoRef.current.currentTime = action.timestampMs / 1_000; }}><time>{duration(action.timestampMs / 1_000)}</time><span>{actionLabel(action.kind)}</span></button>
        <button type="button" className="danger" onClick={() => void recount(index)}>Recontar desde aquí</button></li>)}</ol>
    </section>
  </section>;
}

function RelinkSource({ project, onCancel, onRelinked }: {
  readonly project: PostproductionProject;
  readonly onCancel: () => void;
  readonly onRelinked: (project: PostproductionProject) => void;
}) {
  const [listing, setListing] = useState<PostproductionSourceListing | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browse = async (path?: string) => {
    const result = await adapter.postproductionSources(path);
    if (result.kind === 'error') setError(result.message); else { setListing(result.value); setError(null); }
  };
  useEffect(() => { void browse(); }, []);
  const relink = async (sourcePath: string) => {
    setPending(true); setError(null);
    const result = await adapter.relinkPostproductionSource(project.id, { sourcePath });
    setPending(false);
    if (result.kind === 'error') setError(result.message); else onRelinked(result.value.project);
  };
  return <section className="postproduction-create" aria-labelledby="postproduction-relink-title">
    <header><div><p className="production-kicker">Huella esperada · {project.source.fingerprint.slice(0, 12)}…</p>
      <h3 id="postproduction-relink-title">Reenlazar vídeo original</h3><p>Solo se aceptará un MP4 con contenido idéntico al original.</p></div>
      <button type="button" className="refresh-button" onClick={onCancel} aria-label="Cerrar"><X aria-hidden="true" /></button></header>
    <div className="postproduction-source-picker">
      <div className="postproduction-source-toolbar"><code>/{listing?.current ?? ''}</code>
        <button type="button" disabled={!listing?.parent || pending} onClick={() => void browse(listing?.parent ?? undefined)}>Subir</button></div>
      <div className="postproduction-source-list">
        {listing?.directories.map((directory) => <button type="button" disabled={pending} key={directory.path} onClick={() => void browse(directory.path)}><FolderOpen aria-hidden="true" />{directory.name}</button>)}
        {listing?.files.map((file) => <button type="button" disabled={pending} key={file.path} onClick={() => void relink(file.path)}>
          <Film aria-hidden="true" />{file.name}<small>{bytes(file.sizeBytes)}</small></button>)}
      </div>
    </div>
    {pending ? <p aria-live="polite">Comprobando la huella completa del MP4…</p> : null}
    {error ? <p className="production-command-feedback danger" role="alert">{error}</p> : null}
  </section>;
}

function ManualCorrection({ state, disabled, onApply }: { readonly state: MatchState; readonly disabled: boolean; readonly onApply: (patch: unknown) => void }) {
  const active = state.sets.find((set) => set.status === 'active') ?? state.sets.at(-1)!;
  const [homeGames, setHomeGames] = useState(active.homeGames); const [awayGames, setAwayGames] = useState(active.awayGames);
  const [homePoints, setHomePoints] = useState(state.currentGame.homePoints); const [awayPoints, setAwayPoints] = useState(state.currentGame.awayPoints);
  return <details><summary>Corrección manual</summary><div className="postproduction-correction">
    <label>Juegos L<input type="number" min="0" value={homeGames} onChange={(event) => setHomeGames(Number(event.currentTarget.value))} /></label>
    <label>Juegos V<input type="number" min="0" value={awayGames} onChange={(event) => setAwayGames(Number(event.currentTarget.value))} /></label>
    <label>Puntos L<input type="number" min="0" value={homePoints} onChange={(event) => setHomePoints(Number(event.currentTarget.value))} /></label>
    <label>Puntos V<input type="number" min="0" value={awayPoints} onChange={(event) => setAwayPoints(Number(event.currentTarget.value))} /></label>
    <button type="button" disabled={disabled} onClick={() => onApply({ sets: state.sets.map((set) => set === active ? { ...set, homeGames, awayGames } : set), currentGame: { ...state.currentGame, homePoints, awayPoints } })}>Aplicar corrección</button>
  </div></details>;
}

function splitPlayers(value: string): string[] { const values = value.split('/').map((item) => item.trim()); return [values[0] ?? '', values[1] ?? '']; }
function gameCount(state: MatchState): number { return state.sets.reduce((total, set) => total + set.homeGames + set.awayGames, 0); }
function projectStatus(project: PostproductionProject): string { return project.status === 'editing' ? 'En edición' : project.status === 'rendering' ? 'Generando MP4' : project.status === 'ready' ? 'MP4 listo' : 'Render fallido'; }
function actionLabel(kind: PostproductionActionKind): string { return ({ add_point: 'Punto', undo: 'Deshacer', reset: 'Reset', manual_patch: 'Corrección', update_meta: 'Datos del partido', set_status: 'Estado', update_overlay: 'Layout', use_card: 'Carta', trigger_data_scene: 'Escena de datos', update_sponsor_ticker: 'Ticker', trigger_sponsor_ad: 'Anuncio' } as const)[kind]; }
function duration(seconds: number): string { const safe = Math.max(0, Math.floor(seconds)); return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`; }
function bytes(value: number): string { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(0)} MB`; }
