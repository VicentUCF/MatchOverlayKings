import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, Copy, Link2, Radio, Trash2 } from 'lucide-react';
import type {
  PilotCourtSlug,
  PilotMobileCameraSession,
  PilotMobileVideoProfile,
  UpdatePilotMobileCameraDesiredInput,
} from '@kpl/production-contracts';
import { WhepPreview } from '../lib/pilot-mobile-camera.js';

type MobileCameraPanelProps = {
  readonly courtSlug: PilotCourtSlug;
  readonly mobileCamera: PilotMobileCameraSession | null;
  readonly connectUrl: string | null;
  readonly active: boolean;
  readonly pending: boolean;
  readonly onCreate: () => Promise<unknown>;
  readonly onUpdate: (id: string, input: UpdatePilotMobileCameraDesiredInput) => Promise<boolean>;
  readonly onRevoke: (id: string) => Promise<boolean>;
};

export function PilotMobileCameraPanel({
  courtSlug, mobileCamera, connectUrl, active, pending, onCreate, onUpdate, onRevoke,
}: MobileCameraPanelProps) {
  const owned = mobileCamera?.courtSlug === courtSlug && mobileCamera.state !== 'revoked' ? mobileCamera : null;
  const [cameraId, setCameraId] = useState(owned?.desired.cameraId ?? '');
  const [profile, setProfile] = useState<PilotMobileVideoProfile>(owned?.desired.profile ?? '1080p30');
  const [audioEnabled, setAudioEnabled] = useState(owned?.desired.audioEnabled ?? true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [saving, setSaving] = useState(false);
  const [requestedRevision, setRequestedRevision] = useState<number | null>(null);

  useEffect(() => {
    if (owned === null) return;
    setCameraId(owned.desired.cameraId ?? '');
    setProfile(owned.desired.profile);
    setAudioEnabled(owned.desired.audioEnabled);
  }, [owned?.desired.audioEnabled, owned?.desired.cameraId, owned?.desired.profile, owned?.id]);

  useEffect(() => setRequestedRevision(null), [owned?.id]);

  const selectedCamera = owned?.capabilities?.cameras.find(({ id }) => id === cameraId) ?? null;
  const profiles = selectedCamera?.supportedProfiles ?? [];
  useEffect(() => {
    if (profiles.length > 0 && !profiles.includes(profile)) setProfile(profiles[0] ?? '720p30');
  }, [profile, profiles]);

  const copy = async (): Promise<void> => {
    if (connectUrl === null) return;
    try {
      await navigator.clipboard.writeText(connectUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (owned === null || cameraId === '') return;
    setSaving(true);
    const updated = await onUpdate(owned.id, {
      expectedRevision: owned.desired.revision,
      cameraId,
      profile,
      audioEnabled,
    });
    if (updated) setRequestedRevision(owned.desired.revision + 1);
    setSaving(false);
  };

  const applyingRemotely = owned !== null && owned.claimed
    && owned.applied?.revision !== owned.desired.revision;
  const requestedApplied = requestedRevision !== null
    && (owned?.applied?.revision ?? 0) >= requestedRevision;

  return <section className="pilot-mobile-camera" aria-labelledby={`mobile-camera-${courtSlug}`}>
    <div className="pilot-mobile-camera__heading">
      <div><Camera aria-hidden="true" /><h3 id={`mobile-camera-${courtSlug}`}>Cámara Android</h3></div>
      {owned === null ? null : <CameraState state={owned.state} />}
    </div>

    {owned === null ? <div className="pilot-mobile-camera__empty">
      <p>Genera un enlace temporal y ábrelo en Chrome desde el móvil de esta pista.</p>
      <button type="button" onClick={() => void onCreate()} disabled={pending || active}>
        <Link2 aria-hidden="true" />Generar enlace
      </button>
    </div> : <>
      <div className="pilot-mobile-camera__link">
        {connectUrl === null ? <p>El enlace secreto solo se muestra al crearlo. Revócalo para generar uno nuevo.</p> : <>
          <label htmlFor={`mobile-link-${courtSlug}`}>Enlace temporal</label>
          <div><input id={`mobile-link-${courtSlug}`} value={connectUrl} readOnly />
            <button type="button" onClick={() => void copy()}><Copy aria-hidden="true" />Copiar</button></div>
          <span role="status" aria-live="polite">{copyState === 'copied' ? 'Enlace copiado.' : copyState === 'failed' ? 'No se pudo copiar; selecciónalo manualmente.' : ''}</span>
        </>}
      </div>

      {owned.capabilities === null ? <p className="production-command-feedback">Esperando que el móvil pulse “Preparar cámara”.</p> : <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={active || saving}>
          <legend>Configuración remota</legend>
          <label htmlFor={`mobile-device-${courtSlug}`}>Cámara</label>
          <select id={`mobile-device-${courtSlug}`} value={cameraId} onChange={(event) => setCameraId(event.currentTarget.value)}>
            {owned.capabilities.cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}
          </select>
          <label htmlFor={`mobile-profile-${courtSlug}`}>Resolución y FPS</label>
          <select id={`mobile-profile-${courtSlug}`} value={profile} onChange={(event) => setProfile(event.currentTarget.value as PilotMobileVideoProfile)}>
            {profiles.map((candidate) => <option value={candidate} key={candidate}>{profileLabel(candidate)}</option>)}
          </select>
          <label className="pilot-mobile-camera__audio"><input type="checkbox" checked={audioEnabled}
            disabled={!owned.capabilities.audioAvailable} onChange={(event) => setAudioEnabled(event.currentTarget.checked)} />
            Usar micrófono del móvil</label>
          <button type="submit" disabled={cameraId === '' || profiles.length === 0 || (applyingRemotely && !owned.error)}>
            {saving ? 'Enviando…' : applyingRemotely && !owned.error ? 'Aplicando en el móvil…' : 'Aplicar al móvil'}
          </button>
        </fieldset>
        {applyingRemotely ? <p role="status" aria-live="polite">Android está cambiando la cámara y reconectando la señal…</p>
          : requestedApplied ? <p className="production-command-feedback" role="status">Configuración aplicada en el móvil.</p> : null}
        {requestedRevision !== null && owned.error ? <p className="production-command-feedback danger" role="alert">{owned.error}</p> : null}
        {active ? <p>Detén la emisión para cambiar cámara, FPS o audio.</p> : null}
      </form>}

      <MobileCameraTechnicalStatus mobileCamera={owned} />
      <button className="pilot-mobile-camera__revoke" type="button" disabled={active || pending}
        onClick={() => void onRevoke(owned.id)}><Trash2 aria-hidden="true" />Revocar móvil</button>
    </>}
  </section>;
}

export function PilotMobileCameraMonitor({ mobileCamera }: { readonly mobileCamera: PilotMobileCameraSession }) {
  return <section className="pilot-mobile-monitor" aria-label="Monitor de cámara móvil">
    {mobileCamera.previewUrl === null ? <div className="pilot-mobile-preview pilot-mobile-preview--empty">Sin preview</div>
      : <MobileCameraPreview url={mobileCamera.previewUrl} />}
    <MobileCameraTechnicalStatus mobileCamera={mobileCamera} />
  </section>;
}

export function MobileCameraPreview({ url, allowListening = false }: { readonly url: string; readonly allowListening?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [message, setMessage] = useState('Conectando preview…');
  const [listening, setListening] = useState(false);

  useEffect(() => {
    setMessage('Conectando preview…');
    setListening(false);
    const controller = new AbortController();
    let preview: WhepPreview | null = null;
    let retry: number | null = null;
    let attempt = 0;
    const connect = async () => {
      const currentAttempt = ++attempt;
      await preview?.close();
      if (controller.signal.aborted || attempt !== currentAttempt) return;
      const nextPreview = new WhepPreview(url, (stream) => {
        if (controller.signal.aborted || attempt !== currentAttempt) return;
        if (videoRef.current !== null) videoRef.current.srcObject = stream;
      }, (state) => {
        if (controller.signal.aborted || attempt !== currentAttempt || !['failed', 'disconnected'].includes(state) || retry !== null) return;
        setMessage('Reconectando vista previa…');
        retry = window.setTimeout(() => { retry = null; void connect(); }, 2_000);
      });
      preview = nextPreview;
      try {
        await nextPreview.connect(controller.signal);
      } catch {
        await nextPreview.close();
        if (controller.signal.aborted || attempt !== currentAttempt) return;
        setMessage('Esperando señal móvil…');
        if (retry === null) retry = window.setTimeout(() => { retry = null; void connect(); }, 2_000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (retry !== null) window.clearTimeout(retry);
      void preview?.close();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [url]);

  return <div className="pilot-mobile-preview">
    <video ref={videoRef} autoPlay muted={!listening} playsInline aria-label="Preview de cámara móvil"
      onPlaying={() => setMessage('')} onWaiting={() => setMessage('Esperando imagen de cámara…')} />
    {message ? <span role="status">{message}</span> : null}
    {allowListening ? <button type="button" className="refresh-button production-listen" aria-pressed={listening}
      onClick={() => {
        const next = !listening;
        setListening(next);
        if (videoRef.current) {
          videoRef.current.muted = !next;
          void videoRef.current.play().catch(() => setListening(false));
        }
      }}>{listening ? 'Silenciar escucha en este PC' : 'Escuchar cámara en este PC'}</button> : null}
  </div>;
}

export function MobileCameraTechnicalStatus({ mobileCamera }: { readonly mobileCamera: PilotMobileCameraSession }) {
  const applied = mobileCamera.applied;
  const metrics = mobileCamera.metrics;
  return <dl className="pilot-mobile-technical">
    <div><dt>Aplicado</dt><dd>{applied === null ? '—' : `${applied.width}×${applied.height} · ${formatNumber(applied.framesPerSecond)} FPS`}</dd></div>
    <div><dt>Bitrate</dt><dd>{metrics === null ? '—' : `${Math.round(metrics.bitrateKbps)} kbps`}</dd></div>
    <div><dt>Pérdida</dt><dd>{metrics?.packetLossPercent === null || metrics === null ? '—' : `${formatNumber(metrics.packetLossPercent)} %`}</dd></div>
    <div><dt>RTT</dt><dd>{metrics?.roundTripTimeMs === null || metrics === null ? '—' : `${Math.round(metrics.roundTripTimeMs)} ms`}</dd></div>
    <div><dt>Último reporte</dt><dd>{mobileCamera.lastHeartbeatAt === null ? '—' : new Intl.DateTimeFormat('es-ES', { timeStyle: 'medium' }).format(new Date(mobileCamera.lastHeartbeatAt))}</dd></div>
  </dl>;
}

function CameraState({ state }: { readonly state: PilotMobileCameraSession['state'] }) {
  const value = cameraStateLabel(state);
  return <span className={`production-status ${value.tone}`} role="status"><Radio aria-hidden="true" />{value.label}</span>;
}

function cameraStateLabel(state: PilotMobileCameraSession['state']) {
  switch (state) {
    case 'waiting_permission': return { label: 'Esperando móvil', tone: 'info' } as const;
    case 'connecting': return { label: 'Conectando', tone: 'info' } as const;
    case 'ready': return { label: 'Lista', tone: 'success' } as const;
    case 'degraded': return { label: 'Degradada', tone: 'warning' } as const;
    case 'reconnecting': return { label: 'Reconectando', tone: 'warning' } as const;
    case 'offline': return { label: 'Sin conexión', tone: 'danger' } as const;
    case 'error': return { label: 'Error', tone: 'danger' } as const;
    case 'revoked': return { label: 'Revocada', tone: 'neutral' } as const;
    default: return assertNever(state);
  }
}

function profileLabel(profile: PilotMobileVideoProfile): string {
  switch (profile) {
    case '720p30': return '720p · 30 FPS';
    case '720p60': return '720p · 60 FPS';
    case '1080p30': return '1080p · 30 FPS';
    case '1080p60': return '1080p · 60 FPS';
    default: return assertNever(profile);
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected mobile camera value: ${String(value)}`);
}
