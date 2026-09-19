import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CircleAlert, CircleCheck, Radio, RotateCw, Wifi } from 'lucide-react';
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
  const [portrait, setPortrait] = useState(() => window.matchMedia('(orientation: portrait)').matches);
  const [fullscreen, setFullscreen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [orientationError, setOrientationError] = useState<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(orientation: portrait)');
    const update = () => {
      setPortrait(query.matches);
      setOrientationError(null);
    };
    const updateFullscreen = () => setFullscreen(document.fullscreenElement !== null);
    query.addEventListener('change', update);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => {
      query.removeEventListener('change', update);
      document.removeEventListener('fullscreenchange', updateFullscreen);
    };
  }, []);

  const enterLandscape = async (): Promise<void> => {
    if (rotating) return;
    setRotating(true);
    setOrientationError(null);
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (value: 'landscape') => Promise<void> };
      if (!orientation?.lock || !document.documentElement.requestFullscreen) {
        throw new Error('Orientation unavailable');
      }
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      await orientation.lock('landscape');
    } catch {
      setOrientationError('No se pudo activar el modo horizontal. Activa la rotación automática del móvil y gíralo de lado.');
    } finally {
      setRotating(false);
    }
  };

  const exitFullscreen = async (): Promise<void> => {
    try {
      await document.exitFullscreen();
    } catch {
      setOrientationError('No se pudo salir de pantalla completa. Utiliza el control de salida del navegador.');
    }
  };

  useEffect(() => {
    if (videoRef.current !== null) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => () => { void runtimeRef.current?.stop(); }, []);

  const prepare = async (): Promise<void> => {
    if (link === null || runtimeRef.current !== null || window.matchMedia('(orientation: portrait)').matches) return;
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

    <section className="mobile-camera-orientation" aria-label="Orientación de la cámara">
      <div role="status">
        <RotateCw aria-hidden="true" />
        <p>{portrait ? <><strong>Coloca el móvil en horizontal</strong><span>Activa la rotación automática y gira el móvil para encuadrar la pista.{stream !== null ? ' La cámara sigue conectada.' : ''}</span></>
          : <><strong>Mantén el móvil de lado</strong><span>Comprueba que la pista se ve derecha en la vista previa.</span></>}</p>
      </div>
      {portrait || fullscreen ? <div className="mobile-camera-orientation-actions">
        {portrait ? <button type="button" onClick={() => void enterLandscape()} disabled={rotating}>
          {rotating ? 'Activando…' : 'Activar modo horizontal'}
        </button> : null}
        {fullscreen ? <button type="button" onClick={() => void exitFullscreen()}>Salir de pantalla completa</button> : null}
      </div> : null}
      {orientationError ? <p role="alert">{orientationError}</p> : null}
    </section>

    <section className="mobile-camera-stage" aria-label="Cámara de pista">
      <video ref={videoRef} autoPlay muted playsInline aria-label="Vista previa de la cámara móvil" />
      {stream === null ? <div className="mobile-camera-placeholder">
        <Camera aria-hidden="true" />
        <h1 id="mobile-camera-title">Cámara de pista</h1>
        <p>Conecta este Android al equipo de producción y déjalo con la pantalla encendida.</p>
        <button type="button" onClick={() => void prepare()} disabled={preparing || portrait}>
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
