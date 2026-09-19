import { useEffect, useId, useState } from 'react';
import type { PilotIncident, PilotOperation } from '@kpl/production-contracts';
import { createProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

const adapter = createProductionPilotAdapter();
const actions = { configure: 'Guardar configuración', prepare: 'Preparar emisión', preflight: 'Comprobar programa', start: 'Iniciar emisión', recover: 'Recuperar emisión', stop: 'Finalizar emisión' };
const statuses = { pending: 'Pendiente', completed: 'Solicitud completada', failed: 'Fallida', interrupted: 'Interrumpida' };
const severities = { info: 'Información', warning: 'Advertencia', critical: 'Crítica' };

export function PilotOperationHistory() {
  const courtSelectId = useId();
  const [open, setOpen] = useState(false);
  const [operations, setOperations] = useState<readonly PilotOperation[]>([]);
  const [incidents, setIncidents] = useState<readonly PilotIncident[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [court, setCourt] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all([adapter.operations(), adapter.incidents()]).then(([result, events]) => {
      if (cancelled) return;
      setLoading(false);
      if (result.kind === 'error') setError(result.message);
      else if (events.kind === 'error') setError(events.message);
      else { setOperations(result.value.operations); setIncidents(events.value.incidents); setError(null); }
    });
    return () => { cancelled = true; };
  }, [open, revision]);
  return <details className="production-operation-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Historial de operaciones</summary>
    <p>Una solicitud completada confirma la acción del control. Consulta en cada pista si la emisión está realmente en directo.</p>
    <label htmlFor={courtSelectId}>Pista</label>{' '}
    <select id={courtSelectId} value={court} onChange={(event) => setCourt(event.target.value)}>
      <option value="">Todas las pistas</option>
      {[...new Set([...operations, ...incidents].map(({ courtSlug }) => courtSlug))].sort().map((slug) => <option key={slug}>{slug}</option>)}
    </select>{' '}
    <button type="button" className="refresh-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Actualizar historial</button>
    {loading ? <p role="status">Cargando historial…</p> : null}
    {error ? <p role="alert">{error} Usa Actualizar historial para reintentar.</p> : null}
    {!loading && !error && operations.length === 0 ? <p>Todavía no hay operaciones registradas.</p> : null}
    <ol aria-label="Operaciones recientes" aria-busy={loading}>
      {operations.filter((operation) => !court || operation.courtSlug === court).slice(-100).reverse().map((operation) => <li key={operation.id}>
        <strong>{operation.courtSlug} · {actions[operation.kind]} · {statuses[operation.status]}</strong>
        <p><time dateTime={operation.updatedAt}>{new Date(operation.updatedAt).toLocaleString('es-ES')}</time>
          {operation.matchdayNumber === null ? '' : ` · ${operation.seasonLabel ?? ''} · Jornada ${operation.matchdayNumber}`}</p>
        {operation.message ? <p>{operation.message}</p> : null}
        <small>Diagnóstico: {operation.id}</small>
      </li>)}
    </ol>
    {operations.length > 100 ? <p>Se muestran las últimas 100 operaciones de la pista seleccionada.</p> : null}
    <h3>Incidencias y cambios de estado</h3>
    {!loading && !error && incidents.length === 0 ? <p>Todavía no hay cambios registrados.</p> : null}
    <ol aria-label="Incidencias recientes" aria-busy={loading}>
      {incidents.filter((incident) => !court || incident.courtSlug === court).slice(-100).reverse().map((incident) => <li key={incident.id}>
        <strong>{incident.courtSlug} · {severities[incident.severity]}{incident.category === 'mobile_runtime' ? ' · Servicio de cámaras' : ''}</strong>
        <p>{incident.message}</p>
        <p><time dateTime={incident.createdAt}>{new Date(incident.createdAt).toLocaleString('es-ES')}</time>
          {incident.matchdayNumber === null ? '' : ` · ${incident.seasonLabel ?? ''} · Jornada ${incident.matchdayNumber}`}</p>
        <small>Diagnóstico: {incident.operationId ?? incident.id}</small>
      </li>)}
    </ol>
  </details>;
}
