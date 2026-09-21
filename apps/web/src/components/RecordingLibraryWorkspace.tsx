import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, CircleAlert, ExternalLink, Film, HardDrive, Pause, Play, RefreshCw, Upload } from 'lucide-react';
import type { PublicationJob, RecordingAsset } from '@kpl/production-contracts';
import { createProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

const adapter = createProductionPilotAdapter();

type LibraryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly assets: readonly RecordingAsset[]; readonly jobs: readonly PublicationJob[] };

export function RecordingLibraryWorkspace() {
  const [state, setState] = useState<LibraryState>({ kind: 'loading' });
  const [pending, setPending] = useState<string | null>(null);
  const [courtFilter, setCourtFilter] = useState('all');
  const [matchdayFilter, setMatchdayFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState((current) => current.kind === 'ready' ? current : { kind: 'loading' });
    const result = await adapter.recordings();
    setState(result.kind === 'success'
      ? { kind: 'ready', assets: result.value.assets, jobs: result.value.jobs }
      : { kind: 'error', message: result.message });
  }, []);
  useEffect(() => { void load(); }, [load]);
  const polling = state.kind === 'ready' && state.jobs.some(({ state: jobState }) => ['uploading', 'processing'].includes(jobState));
  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [load, polling]);

  const mutate = async (key: string, action: () => Promise<{ readonly kind: 'success' } | { readonly kind: 'error'; readonly message: string }>) => {
    setPending(key);
    const result = await action();
    setPending(null);
    if (result.kind === 'error') setState({ kind: 'error', message: result.message });
    else await load(true);
  };

  if (state.kind === 'loading') return <p className="production-pilot-loading">Cargando grabaciones…</p>;
  if (state.kind === 'error') return <div className="production-page-feedback danger" role="alert">
    <CircleAlert aria-hidden="true" /><span>{state.message}</span>
    <button type="button" className="refresh-button" onClick={() => void load()}><RefreshCw aria-hidden="true" />Reintentar</button>
  </div>;

  const assets = state.assets.filter((asset) =>
    (courtFilter === 'all' || asset.courtSlug === courtFilter)
    && (matchdayFilter === 'all' || String(asset.matchdayNumber) === matchdayFilter)
    && (stateFilter === 'all' || (state.jobs.find(({ assetId }) => assetId === asset.id)?.state ?? asset.state) === stateFilter));
  const courts = [...new Set(state.assets.map(({ courtSlug }) => courtSlug))].sort();
  const matchdays = [...new Set(state.assets.map(({ matchdayNumber }) => matchdayNumber))].sort((a, b) => a - b);

  return <section className="recording-library" aria-labelledby="recording-library-title">
    <header className="production-pilot-intro">
      <div><p className="production-kicker">Archivo y publicación</p><h1 id="recording-library-title">Grabaciones</h1>
        <p>Valida los MP4 del programa final, súbelos como privados y programa cuándo se harán públicos.</p></div>
      <button type="button" className="refresh-button" onClick={() => void load()}><RefreshCw aria-hidden="true" />Actualizar</button>
    </header>
    <div className="recording-library__filters" aria-label="Filtros de grabaciones">
      <label>Pista<select value={courtFilter} onChange={(event) => setCourtFilter(event.currentTarget.value)}>
        <option value="all">Todas</option>{courts.map((court) => <option key={court} value={court}>{court}</option>)}</select></label>
      <label>Jornada<select value={matchdayFilter} onChange={(event) => setMatchdayFilter(event.currentTarget.value)}>
        <option value="all">Todas</option>{matchdays.map((matchday) => <option key={matchday} value={matchday}>{matchday}</option>)}</select></label>
      <label>Estado<select value={stateFilter} onChange={(event) => setStateFilter(event.currentTarget.value)}>
        <option value="all">Todos</option><option value="recording">Grabando</option><option value="validating">Validando</option>
        <option value="ready">MP4 listo</option><option value="invalid">No válido</option><option value="uploading">Subiendo</option>
        <option value="paused">Pausado</option><option value="processing">Procesando</option><option value="private_ready">Privado listo</option>
        <option value="scheduled">Programado</option><option value="published">Publicado</option><option value="failed">Fallido</option></select></label>
    </div>
    {state.assets.length === 0 ? <div className="production-pilot-empty-state"><Film aria-hidden="true" />
      <h2>Todavía no hay grabaciones</h2><p>Los archivos aparecerán aquí al detener una grabación desde Producción.</p></div> : null}
    {state.assets.length > 0 && assets.length === 0 ? <p className="production-page-feedback">No hay grabaciones que coincidan con los filtros.</p> : null}
    <div className="recording-library__grid">
      {assets.map((asset) => <RecordingCard key={asset.id} asset={asset}
        job={state.jobs.find(({ assetId }) => assetId === asset.id) ?? null} pending={pending}
        onCreate={(input) => mutate(asset.id, () => adapter.createPublication(asset.id, input))}
        onPause={(job) => mutate(job.id, () => adapter.pausePublication(job.id))}
        onResume={(job) => mutate(job.id, () => adapter.resumePublication(job.id))}
        onSchedule={(job, publishAt) => mutate(job.id, () => adapter.schedulePublication(job.id, publishAt))} />)}
    </div>
  </section>;
}

function RecordingCard({ asset, job, pending, onCreate, onPause, onResume, onSchedule }: {
  readonly asset: RecordingAsset;
  readonly job: PublicationJob | null;
  readonly pending: string | null;
  readonly onCreate: (input: { readonly title: string; readonly description: string }) => Promise<void>;
  readonly onPause: (job: PublicationJob) => Promise<void>;
  readonly onResume: (job: PublicationJob) => Promise<void>;
  readonly onSchedule: (job: PublicationJob, publishAt: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(asset.title.slice(0, 100));
  const [description, setDescription] = useState('Partido de Kings Padel League.');
  const [publishAt, setPublishAt] = useState(() => localDateTime(Date.now() + 24 * 60 * 60_000));
  const progress = job && job.totalBytes > 0 ? Math.min(100, Math.round(job.uploadedBytes / job.totalBytes * 100)) : 0;
  const media = useMemo(() => asset.streams.map(({ kind, codec }) => `${kind === 'video' ? 'Vídeo' : 'Audio'} ${codec.toUpperCase()}`).join(' · '), [asset.streams]);
  const submitUpload = (event: FormEvent) => { event.preventDefault(); void onCreate({ title, description }); };
  const submitSchedule = (event: FormEvent) => { event.preventDefault(); if (job) void onSchedule(job, new Date(publishAt).toISOString()); };
  return <article className="recording-card" aria-labelledby={`recording-${asset.id}`}>
    <header><div><span className="production-court-card__slug">{asset.courtSlug}</span><h2 id={`recording-${asset.id}`}>{asset.title}</h2></div>
      <span className={`production-status ${asset.state === 'ready' ? 'success' : asset.state === 'invalid' ? 'danger' : 'info'}`}>{assetLabel(asset)}</span></header>
    <dl className="recording-card__facts">
      <div><dt>Jornada</dt><dd>{asset.matchdayNumber} · {asset.seasonLabel}</dd></div>
      <div><dt>Duración</dt><dd>{asset.durationSeconds === null ? '—' : duration(asset.durationSeconds)}</dd></div>
      <div><dt>Tamaño</dt><dd>{asset.sizeBytes === null ? '—' : bytes(asset.sizeBytes)}</dd></div>
      <div><dt>Formato</dt><dd>{media || 'Pendiente'}</dd></div>
    </dl>
    <p className="recording-card__path"><HardDrive aria-hidden="true" /><code>{asset.path}</code></p>
    {asset.error ? <p className="production-command-feedback danger" role="alert">{asset.error}</p> : null}
    {!job ? <form className="recording-card__form" onSubmit={submitUpload}>
      <label>Título en YouTube<input required maxLength={100} value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label>Descripción<textarea required maxLength={5_000} value={description} onChange={(event) => setDescription(event.currentTarget.value)} /></label>
      <button className="production-setup-submit" type="submit" disabled={asset.state !== 'ready' || pending === asset.id}>
        <Upload aria-hidden="true" />{pending === asset.id ? 'Preparando…' : 'Subir como privado'}</button>
    </form> : <section className="recording-publication" aria-label="Publicación en YouTube">
      <div className="recording-publication__status"><strong>{publicationLabel(job)}</strong><span>{progress}% subido</span></div>
      <progress max="100" value={progress}>{progress}%</progress>
      {job.error ? <p className="production-command-feedback danger" role="alert">{job.error}</p> : null}
      <div className="recording-publication__actions">
        {job.state === 'uploading' ? <button type="button" className="refresh-button" disabled={pending === job.id} onClick={() => void onPause(job)}><Pause aria-hidden="true" />Pausar</button> : null}
        {['paused', 'failed'].includes(job.state) && !job.youtubeVideoId ? <button type="button" className="production-setup-submit" disabled={pending === job.id} onClick={() => void onResume(job)}><Play aria-hidden="true" />Reanudar</button> : null}
        {job.watchUrl ? <a className="refresh-button" href={job.watchUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />Abrir en YouTube</a> : null}
      </div>
      {['private_ready', 'scheduled'].includes(job.state) ? <form className="recording-card__schedule" onSubmit={submitSchedule}>
        <label>Publicar el<input type="datetime-local" required min={localDateTime(Date.now() + 60_000)} value={publishAt}
          onChange={(event) => setPublishAt(event.currentTarget.value)} /></label>
        <button className="production-setup-submit" type="submit" disabled={pending === job.id}><CalendarClock aria-hidden="true" />{job.state === 'scheduled' ? 'Reprogramar' : 'Programar publicación'}</button>
      </form> : null}
      {job.publishAt ? <p>Publicación: <time dateTime={job.publishAt}>{new Date(job.publishAt).toLocaleString('es-ES')}</time></p> : null}
    </section>}
  </article>;
}

function assetLabel(asset: RecordingAsset): string {
  if (asset.state === 'recording') return 'Grabando';
  if (asset.state === 'validating') return 'Validando';
  if (asset.state === 'ready') return 'MP4 listo';
  return 'MP4 no válido';
}
function publicationLabel(job: PublicationJob): string {
  return ({ uploading: 'Subiendo como privado', paused: 'Subida pausada', processing: 'Procesando en YouTube',
    private_ready: 'Privado y listo', scheduled: 'Publicación programada', published: 'Publicado', failed: 'Subida interrumpida' } as const)[job.state];
}
function duration(seconds: number): string { return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
function localDateTime(value: number): string {
  const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
