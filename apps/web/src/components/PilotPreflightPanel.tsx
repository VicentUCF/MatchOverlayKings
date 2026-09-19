import { useEffect, useRef, useState } from 'react';
import type { PilotPreflightCheckId, PilotSession } from '@kpl/production-contracts';
import type { ProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

export function preflightIsFresh(session: PilotSession): boolean {
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
  const fresh = preflightIsFresh(session);
  const priority = { blocked: 0, warning: 1, pending: 2, running: 3, pass: 4, not_applicable: 5 };
  const checks = [...(report?.checks ?? [])].sort((a, b) => priority[a.status] - priority[b.status]);
  const notices = checks.filter(({ status }) => ['blocked', 'warning'].includes(status));
  const unchecked = report?.checks.filter(({ status }) => status === 'pending') ?? [];
  const completed = report?.checks.filter(({ status }) => !['running', 'pending'].includes(status)).length ?? 0;
  const label = running ? `Comprobando programa… ${completed}/${report.checks.length}`
    : report?.status === 'stale' || (report?.validUntil && !fresh) ? 'Resultados anteriores'
      : report?.status === 'cancelled' ? 'Comprobación cancelada'
        : !report ? 'Comprobación opcional' : notices.length ? `${notices.length} aviso${notices.length === 1 ? '' : 's'} en la prueba`
          : unchecked.length ? 'Prueba incompleta' : 'Prueba completada';
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
    <p>Estos resultados son informativos. Tú decides cuándo emitir.</p>
    {!running && notices[0] ? <p className="pilot-preflight__notice"><strong>{notices[0].label}:</strong> {notices[0].message}</p> : null}
    <details>
      <summary>{report ? `Ver resultados (${report.checks.length})${unchecked.length ? ` · ${unchecked.length} sin comprobar` : ''}` : 'Qué incluye la prueba'}</summary>
      <p>Graba diez segundos del programa con marcador y audio en este PC, sin emitir a YouTube.</p>
      {session.mode === 'youtube' ? <p>Con las salidas detenidas, también mide la subida enviando hasta 26 MiB de datos de prueba a Cloudflare, sin vídeo ni audio. La medición se comparte durante cinco minutos.</p> : null}
      {report ? <ul>{checks.map((check) => <li key={check.id} className={`pilot-preflight__check pilot-preflight__check--${check.status}`}>
        <details>
          <summary><strong>{check.label}</strong><span>{{ pending: 'Sin comprobar', running: 'Comprobando', pass: 'Correcto', warning: 'Aviso', blocked: 'Revisar', not_applicable: 'No necesario' }[check.status]}</span></summary>
          <p>{check.message}</p>
          {(['blocked', 'warning', 'pending'].includes(check.status) || (check.id === 'network' && check.status === 'pass')) && !['running', 'stale', 'cancelled'].includes(report.status)
            ? <button type="button" className="refresh-button" disabled={pending} onClick={() => onCheck(check.id)}>Repetir: {check.label}</button> : null}
        </details>
      </li>)}</ul> : null}
    </details>
    <div className="production-pilot-actions">
      {running ? <button type="button" className="refresh-button" onClick={onCancel}>Cancelar comprobación</button>
        : <button type="button" className="refresh-button" disabled={pending} onClick={() => onCheck()}>Comprobar programa completo</button>}
      {preview && !running ? <button type="button" className="refresh-button" disabled={loading} onClick={() => void open()}>
        {loading ? 'Cargando programa…' : 'Ver programa de prueba'}
      </button> : null}
    </div>
    {report?.finishedAt ? <p className="pilot-preflight__timestamp">Última prueba: {new Date(report.finishedAt).toLocaleTimeString('es-ES')}. Puedes repetirla si cambias la fuente o el perfil.</p> : null}
    {video ? <><video controls preload="metadata" src={video} aria-label="Programa de prueba con marcador y audio" />
      <p>Revisa los equipos y el tanteo, y escucha el audio antes de emitir.</p></> : null}
    {error ? <p role="alert" className="production-command-feedback danger">{error}</p> : null}
  </section>;
}
