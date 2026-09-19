import { useEffect, useRef, useState } from 'react';
import type { PilotPreflightCheckId, PilotSession } from '@kpl/production-contracts';
import type { ProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

export function preflightCanStart(session: PilotSession): boolean {
  const report = session.preflight;
  return !!report && ['ready', 'warning'].includes(report.status) && report.validUntil !== null
    && Date.parse(report.validUntil) > Date.now();
}

export function PilotPreflightPanel({ session, pending, onCheck, onCancel, loadPreview }: {
  readonly session: PilotSession;
  readonly pending: boolean;
  readonly onCheck: (check?: PilotPreflightCheckId) => void;
  readonly onCancel: () => void;
  readonly loadPreview: ProductionPilotAdapter['preview'];
}) {
  const report = session.preflight;
  const running = report?.status === 'running';
  const fresh = preflightCanStart(session);
  const label = running ? 'Comprobando programa…' : fresh ? report?.status === 'warning' ? 'Lista con advertencias' : 'Lista'
    : report?.status === 'stale' ? 'Comprobación caducada' : report?.status === 'cancelled' ? 'Comprobación cancelada' : 'Bloqueada hasta comprobar';
  const [video, setVideo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const preview = report?.preview?.url;
  useEffect(() => {
    setVideo(null); setLoading(false); setError(null);
    return () => {
      request.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [preview]);
  const open = async () => {
    if (!preview) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    const result = await loadPreview(preview, controller.signal);
    if (controller.signal.aborted) return;
    setLoading(false);
    if (result.kind === 'error') { setError(result.message); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(result.value); setVideo(objectUrl.current);
  };
  return <section className="pilot-preflight" aria-label="Comprobación antes de emitir">
    <h4 role="status">{label}</h4>
    <p>Comprueba la pista y graba diez segundos del programa con marcador y audio. La prueba se guarda en este PC y no emite a YouTube.</p>
    {session.mode === 'youtube' ? <p>Con las salidas detenidas, también mide la subida desde este PC enviando hasta 26 MiB de datos de prueba a Cloudflare, sin vídeo ni audio. Las pistas comparten la medición durante cinco minutos. Repite Red si cambias de conexión.</p> : null}
    {report ? <details open={running || report.status === 'blocked'}>
      <summary>Resultados de las comprobaciones</summary>
      <ul>{report.checks.map((check) => <li key={check.id} className={`pilot-preflight__check pilot-preflight__check--${check.status}`}>
        <strong>{check.label} · {{ pending: 'Pendiente', running: 'Comprobando', pass: 'Correcto', warning: 'Advertencia', blocked: 'Bloqueo', not_applicable: 'No necesario' }[check.status]}</strong>
        <p>{check.message}</p>
        {(['blocked', 'warning'].includes(check.status) || (check.id === 'network' && check.status === 'pass')) && !['running', 'stale', 'cancelled'].includes(report.status)
          ? <button type="button" className="refresh-button" disabled={pending} onClick={() => onCheck(check.id)}>Repetir: {check.label}</button> : null}
      </li>)}</ul>
    </details> : null}
    <div className="production-pilot-actions">
      {running ? <button type="button" className="refresh-button" onClick={onCancel}>Cancelar comprobación</button>
        : <button type="button" className="refresh-button" disabled={pending} onClick={() => onCheck()}>Comprobar programa completo</button>}
      {preview && !running ? <button type="button" className="refresh-button" disabled={loading} onClick={() => void open()}>
        {loading ? 'Cargando programa…' : 'Ver programa de prueba'}
      </button> : null}
    </div>
    {fresh && report?.validUntil ? <p>Válida hasta las {new Date(report.validUntil).toLocaleTimeString('es-ES')}. Repite la comprobación si cambias la fuente o el perfil.</p> : null}
    {video ? <><video controls preload="metadata" src={video} aria-label="Programa de prueba con marcador y audio" />
      <p>Revisa los equipos y el tanteo, y escucha el audio antes de emitir.</p></> : null}
    {error ? <p role="alert" className="production-command-feedback danger">{error}</p> : null}
  </section>;
}
