import { useEffect, useRef, useState } from 'react';
import { Camera, Copy, ExternalLink, MonitorPlay } from 'lucide-react';
import { formatPoint, type MatchState, type Team } from '@kpl/shared';
import type { PilotConfiguration, PilotMobileCameraSession, PilotSession } from '@kpl/production-contracts';
import { supabase } from '../lib/supabase.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';
import { MobileCameraPreview, MobileCameraTechnicalStatus } from './PilotMobileCameraPanel.js';

export function useMonitorClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function CourtCameraMonitor({ courtSlug, mobileCamera, source, detailed = false }: {
  readonly courtSlug: string;
  readonly mobileCamera: PilotMobileCameraSession | null;
  readonly source: string | undefined;
  readonly detailed?: boolean;
}) {
  const mobile = source === 'mobile:pilot';
  return <section className="production-camera-monitor" aria-label="Previsualización de cámara con overlay">
    <div className="production-monitor-label"><Camera aria-hidden="true" /><strong>Cámara + overlay</strong>
      <span>{mobile ? cameraLabel(mobileCamera) : source === 'synthetic' ? 'Señal de prueba' : 'Fuente local'}</span></div>
    {mobile && mobileCamera?.previewUrl && mobileCamera.state !== 'revoked'
      ? <MobileCameraPreview key={mobileCamera.id} url={mobileCamera.previewUrl} allowListening={detailed}>
        <CameraOverlay key={courtSlug} courtSlug={courtSlug} />
      </MobileCameraPreview>
      : <div className="production-monitor-placeholder"><Camera aria-hidden="true" />
        <strong>{mobile ? 'Sin vista previa de cámara' : 'Esta fuente no ofrece vista previa en vivo'}</strong>
        <p>{mobile ? 'Comprueba el enlace y la conexión del móvil.' : 'Revisa el programa de prueba antes de emitir y la salida en YouTube durante el directo.'}</p>
      </div>}
    {detailed ? <p className="production-monitor-note">Vista previa local con los gráficos de emisión. Disponible antes de iniciar YouTube. La escucha solo afecta a este PC; comprueba el vídeo y audio codificados con la prueba de emisión.</p> : null}
    {detailed && mobile && mobileCamera ? <details className="production-camera-diagnostics"><summary>Formato y conexión de cámara</summary>
      <MobileCameraTechnicalStatus mobileCamera={mobileCamera} /></details> : null}
    {mobileCamera?.error && mobile ? <p className="production-command-feedback warning" role="status">{mobileCamera.error}</p> : null}
  </section>;
}

function CameraOverlay({ courtSlug }: { readonly courtSlug: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  return <div className="production-camera-overlay" ref={frame}>
    <iframe src={`/overlay/${encodeURIComponent(courtSlug)}/scoreboard?preview=muted`}
      title={`Overlay sobre cámara de ${courtSlug}`} tabIndex={-1}
      style={{ transform: `scale(${width / 1920})` }} />
  </div>;
}

function cameraLabel(camera: PilotMobileCameraSession | null): string {
  if (!camera) return 'Sin conectar';
  return { ready: 'Lista', connecting: 'Conectando', waiting_permission: 'Esperando permisos', degraded: 'Revisar cámara',
    reconnecting: 'Reconectando', offline: 'Sin conexión', error: 'Error', revoked: 'Revocada' }[camera.state];
}

export function CourtScoreMonitor({ courtSlug, configuration, now }: {
  readonly courtSlug: string;
  readonly configuration: PilotConfiguration | null;
  readonly now: number;
}) {
  // This surface only reads. Points remain under the separate scorer's control.
  // The overlay role also polls to recover from a lost Realtime subscription.
  const match = useMatchSocket(courtSlug, 'overlay', '');
  return <CourtScoreMonitorView state={match.state} teams={match.teams} configuration={configuration}
    confirmedAt={match.confirmedAt} stale={match.connectionState === 'error' || match.connectionState === 'disconnected'
      || (match.confirmedAt !== null && now - match.confirmedAt > 15_000)} error={match.error} />;
}

export function CourtScoreMonitorView({ state, teams, configuration, confirmedAt, stale, error }: {
  readonly state: MatchState | null;
  readonly teams: readonly Team[];
  readonly configuration: PilotConfiguration | null;
  readonly confirmedAt: number | null;
  readonly stale: boolean;
  readonly error: string | null;
}) {
  return <section className="production-score-monitor" aria-label="Marcador del anotador, solo lectura">
    <div className="production-monitor-label"><MonitorPlay aria-hidden="true" /><strong>Marcador del anotador</strong>
      <span>{stale ? 'Sin confirmar' : state ? { pre_match: 'Prepartido', live: 'En juego', finished: 'Finalizado' }[state.status] : 'Esperando datos'}</span></div>
    {state ? <table><caption className="production-sr-only">Resultado actualizado por el anotador</caption>
      <thead><tr><th scope="col">Equipo</th>{state.sets.map((_, index) => <th key={index} scope="col">S{index + 1}</th>)}<th scope="col">Puntos</th></tr></thead>
      <tbody>{(['home', 'away'] as const).map((side) => <tr key={side}>
        <th scope="row">{teams.find(({ id }) => id === (side === 'home' ? state.homeTeamId : state.awayTeamId))?.shortName
          ?? (side === 'home' ? configuration?.homeTeam : configuration?.awayTeam) ?? (side === 'home' ? 'Local' : 'Visitante')}
          {state.servingSide === side ? <span className="production-score-serve" aria-label="Al saque"> ●</span> : null}</th>
        {state.sets.map((set, index) => <td key={index}>{side === 'home' ? set.homeGames : set.awayGames}</td>)}
        <td className="production-score-points">{formatPoint(state, side)}</td>
      </tr>)}</tbody>
    </table> : <div>{configuration ? <strong>{configuration.homeTeam} vs {configuration.awayTeam}</strong> : null}
      <p>{error ? 'No se puede cargar el marcador.' : confirmedAt !== null ? 'Todavía no hay partido en esta pista.' : 'Conectando con el marcador…'}</p></div>}
    {stale ? <p className="production-command-feedback warning" role="status">Marcador sin confirmar. Se conserva el último resultado recibido.</p> : null}
    {error ? <p className="production-monitor-note" role="status">{error}</p> : null}
    <p className="production-monitor-note">{confirmedAt !== null ? `Datos comprobados a las ${new Date(confirmedAt).toLocaleTimeString('es-ES')}.` : 'Esperando confirmación de datos.'} Solo lectura.</p>
  </section>;
}

export function CourtOverlayMonitor({ courtSlug }: { readonly courtSlug: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [open]);
  return <details className="production-overlay-monitor" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Ver gráficos de emisión · overlay en directo</summary>
    {open ? <><div className="production-dashboard-preview" ref={frame}>
      <iframe src={`/overlay/${courtSlug}/scoreboard`} title={`Overlay en tiempo real de ${courtSlug}`} tabIndex={-1}
        style={{ transform: `scale(${width / 1920})` }} />
    </div>
    <p className="production-monitor-note">Gráficos en vivo, también superpuestos en la vista previa de cámara.</p></> : null}
  </details>;
}

export function ScorerAccess({ courtSlug, seasonLabel, matchdayNumber }: {
  readonly courtSlug: string;
  readonly seasonLabel: string;
  readonly matchdayNumber: number;
}) {
  const [copied, setCopied] = useState<'idle' | 'success' | 'error'>('idle');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setUrl(''); setCopied('idle'); setError(null); }, [courtSlug]);
  const generate = async () => {
    setPending(true);
    setError(null);
    setCopied('idle');
    try {
      const { data, error: rpcError } = await supabase.rpc('create_visual_control_link', {
        p_court_slug: courtSlug, p_season_label: seasonLabel, p_matchday_number: matchdayNumber,
      });
      if (rpcError) throw new Error(rpcError.message);
      const payload = data as { token?: unknown; expiresAt?: unknown } | null;
      if (typeof payload?.token !== 'string' || !/^[a-f0-9]{64}$/.test(payload.token)) throw new Error('No se pudo generar el enlace.');
      const origin = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
        ? 'https://live.kingspadelleague.es' : window.location.origin;
      setUrl(`${origin}/control/${courtSlug}#token=${payload.token}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo generar el enlace.');
    } finally { setPending(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied('success'); }
    catch { setCopied('error'); }
  };
  const revoke = async () => {
    setPending(true); setError(null);
    const { error: rpcError } = await supabase.rpc('revoke_visual_control_link', { p_court_slug: courtSlug });
    setPending(false);
    if (rpcError) { setError(rpcError.message); return; }
    setUrl(''); setCopied('idle');
  };
  return <details className="production-scorer-access">
    <summary>Enlace y acceso del anotador</summary>
    <p>Válido para {seasonLabel}, jornada {matchdayNumber}, durante 18 horas. El anotador puede usarlo sin iniciar sesión y generar otro invalida el anterior.</p>
    <button type="button" className="refresh-button" disabled={pending} onClick={() => void generate()}>
      {pending ? 'Generando…' : url ? 'Generar nuevo enlace' : 'Generar enlace de acceso directo'}
    </button>
    {url ? <><label>Enlace para esta pista<input readOnly value={url} onFocus={(event) => event.currentTarget.select()} /></label>
      <div className="production-dashboard-actions"><button type="button" className="refresh-button" disabled={pending} onClick={() => void copy()}><Copy aria-hidden="true" />Copiar enlace para anotador</button>
        <a className="refresh-button" href={url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />Abrir control del anotador</a>
        <button type="button" className="refresh-button" disabled={pending} onClick={() => void revoke()}>Revocar enlace</button></div></> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p role="status">{copied === 'success' ? 'Enlace copiado. Entrégalo al anotador de esta pista.'
      : copied === 'error' ? 'No se pudo copiar. Selecciona el enlace y cópialo manualmente.' : 'El estado del marcador confirma los datos, no la presencia de una persona.'}</p>
  </details>;
}

export function sessionIssues(session: PilotSession | null): string[] {
  if (!session || session.status === 'stopped') return [];
  return [session.error, session.encodingWarning,
    session.continuity?.active ? 'Continuidad activa: imagen de espera y audio silenciado.' : null,
    session.overlayHealth && session.overlayHealth.status !== 'ready' ? session.overlayHealth.reason ?? 'Revisar marcador de emisión.' : null,
    ...(session.signal?.issues.map(({ message }) => message) ?? []),
    session.status === 'interrupted' ? 'Emisión interrumpida: recupera o finaliza la sesión.' : null,
    session.status === 'failed' ? 'La sesión necesita intervención.' : null,
  ].filter((value): value is string => Boolean(value));
}
