import type { PilotSignalHealth } from '@kpl/production-contracts';

export function PilotSignalStatus({ signal, courtSlug, continuity = false }: {
  readonly signal: PilotSignalHealth | null | undefined; readonly courtSlug: string; readonly continuity?: boolean;
}) {
  if (!signal || signal.checking) return <p role="status">Comprobando la señal de {courtSlug}…</p>;
  return <section aria-label={`Calidad de señal de ${courtSlug}`}>
    {signal.issues.length > 0 ? <div className="production-command-feedback warning" role="alert">
      <strong>Revisar señal de {courtSlug}</strong>
      <ul>{signal.issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>
    </div> : <p>{continuity ? 'Se comprueba el avance de la salida mientras se recupera la cámara.' : 'Sin avisos detectados en la última comprobación.'}</p>}
    <details>
      <summary>Mediciones recientes de señal</summary>
      <dl className="production-pilot-metrics">
        <div><dt>FPS recientes</dt><dd>{format(signal.measuredFramesPerSecond, 1)}</dd></div>
        <div><dt>Velocidad reciente</dt><dd>{format(signal.measuredSpeed, 2, '×')}</dd></div>
        <div><dt>Bitrate reciente</dt><dd>{format(signal.measuredBitrateKbps, 0, ' kb/s')}</dd></div>
        <div><dt>Frames perdidos</dt><dd>{format(signal.droppedFrameRatio === null ? null : signal.droppedFrameRatio * 100, 1, ' %')}</dd></div>
      </dl>
      <p>{continuity ? 'Audio silenciado durante la continuidad. La comprobación del micrófono se reanuda cuando vuelve la cámara.'
        : signal.audioExpected ? 'Detección de silencio del micrófono activa.' : 'No se espera audio de micrófono con esta configuración.'}</p>
      <p>Última comprobación: <time dateTime={signal.sampledAt}>{new Date(signal.sampledAt).toLocaleTimeString('es-ES')}</time>.</p>
    </details>
  </section>;
}

function format(value: number | null, digits: number, unit = ''): string {
  return value === null ? 'Sin datos' : `${value.toFixed(digits)}${unit}`;
}
