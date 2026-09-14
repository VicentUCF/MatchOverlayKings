import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CircleAlert, CircleCheck, Radio, Wifi } from 'lucide-react';
import {
  PilotMobileCameraRuntime,
  PilotMobileApiError,
  parsePilotMobileLink,
  type PilotMobileRuntimeSnapshot,
} from '../lib/pilot-mobile-camera.js';

const INITIAL_SNAPSHOT: PilotMobileRuntimeSnapshot = {
  state: 'waiting_permission',
  desired: null,
  applied: null,
  metrics: null,
  wakeLockActive: false,
  error: null,
};

export function MobileCameraPage() {
  const link = useMemo(() => parsePilotMobileLink(window.location.hash), []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const runtimeRef = useRef<PilotMobileCameraRuntime | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (videoRef.current !== null) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => () => { void runtimeRef.current?.stop(); }, []);

  const prepare = async (): Promise<void> => {
    if (link === null || runtimeRef.current !== null) return;
    setPreparing(true);
    const runtime = new PilotMobileCameraRuntime(link, {
      onStream: setStream,
      onSnapshot: setSnapshot,
    });
    runtimeRef.current = runtime;
    try {
      await runtime.prepare();
    } catch (error) {
      setSnapshot((current) => ({
        ...current,
        state: error instanceof PilotMobileApiError && error.code === 'EXPIRED' ? 'revoked' : 'error',
        error: error instanceof Error ? error.message : 'No se pudo preparar la cámara.',
      }));
      await runtime.stop();
      runtimeRef.current = null;
    } finally {
      setPreparing(false);
    }
  };

  if (link === null) {
    return <main className="mobile-camera-page mobile-camera-page--message">
      <CircleAlert aria-hidden="true" />
      <h1>Enlace de cámara no válido</h1>
      <p>Solicita un enlace nuevo desde el panel de emisiones KPL.</p>
    </main>;
  }

  const presentation = statePresentation(snapshot.state);
  return <main className="mobile-camera-page">
    <header className="mobile-camera-header">
      <img src="/logos/kpl-wordmark.png" alt="Kings Padel League" />
      <span className={`mobile-camera-state ${presentation.tone}`} role="status" aria-live="polite">
        {presentation.ready ? <CircleCheck aria-hidden="true" /> : <Radio aria-hidden="true" />}
        {presentation.label}
      </span>
    </header>

    <section className="mobile-camera-stage" aria-labelledby="mobile-camera-title">
      <video ref={videoRef} autoPlay muted playsInline aria-label="Vista previa de la cámara móvil" />
      {stream === null ? <div className="mobile-camera-placeholder">
        <Camera aria-hidden="true" />
        <h1 id="mobile-camera-title">Cámara de pista</h1>
        <p>Conecta este Android al equipo de producción y déjalo con la pantalla encendida.</p>
        <button type="button" onClick={() => void prepare()} disabled={preparing} autoFocus>
          {preparing ? 'Preparando…' : 'Preparar cámara'}
        </button>
      </div> : null}
    </section>

    {snapshot.error ? <p className="mobile-camera-alert" role="alert"><CircleAlert aria-hidden="true" />{snapshot.error}</p> : null}

    <section className="mobile-camera-telemetry" aria-label="Estado técnico">
      <div><span>Cámara</span><strong>{snapshot.applied === null ? 'Esperando panel' : cameraLabel(snapshot.applied.cameraId)}</strong></div>
      <div><span>Formato</span><strong>{snapshot.applied === null ? '—' : `${snapshot.applied.width}×${snapshot.applied.height} · ${formatFps(snapshot.applied.framesPerSecond)} FPS`}</strong></div>
      <div><span>Red</span><strong><Wifi aria-hidden="true" />{snapshot.metrics === null ? 'Midiendo' : `${Math.round(snapshot.metrics.bitrateKbps)} kbps`}</strong></div>
      <div><span>Pantalla</span><strong>{snapshot.wakeLockActive ? 'Bloqueo activo' : 'No bloqueada'}</strong></div>
    </section>

    <p className="mobile-camera-footnote">No cierres Chrome ni cambies de aplicación durante el partido.</p>
  </main>;
}

function statePresentation(state: PilotMobileRuntimeSnapshot['state']) {
  switch (state) {
    case 'waiting_permission': return { label: 'Sin preparar', tone: 'neutral', ready: false } as const;
    case 'connecting': return { label: 'Conectando', tone: 'warning', ready: false } as const;
    case 'ready': return { label: 'Lista', tone: 'success', ready: true } as const;
    case 'degraded': return { label: 'Señal degradada', tone: 'warning', ready: false } as const;
    case 'reconnecting': return { label: 'Reconectando', tone: 'warning', ready: false } as const;
    case 'offline': return { label: 'Sin conexión', tone: 'danger', ready: false } as const;
    case 'error': return { label: 'Error', tone: 'danger', ready: false } as const;
    case 'revoked': return { label: 'Enlace revocado', tone: 'danger', ready: false } as const;
    default: return assertNever(state);
  }
}

function cameraLabel(cameraId: string): string {
  return cameraId.length > 18 ? `…${cameraId.slice(-12)}` : cameraId;
}

function formatFps(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected camera state: ${String(value)}`);
}
