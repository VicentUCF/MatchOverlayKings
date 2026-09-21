import { randomUUID } from 'node:crypto';
import { PilotPreflightCheckIdSchema, PilotPreflightSchema,
  type PilotPreflight, type PilotPreflightCheck, type PilotPreflightCheckId } from '@kpl/production-contracts';

export const PREFLIGHT_LIFETIME_MS = 5 * 60_000;
export const MEDIA_CHECKS: readonly PilotPreflightCheckId[] = ['camera', 'audio', 'encoder', 'bitrate', 'overlay'];
const LABELS: Record<PilotPreflightCheckId, string> = {
  configuration: 'Partido y equipos', camera: 'Señal de cámara', profile: 'Perfil de vídeo', audio: 'Audio',
  storage: 'Espacio disponible', cpu: 'Carga del equipo', memory: 'Memoria disponible', encoder: 'Codificación del programa',
  network: 'Red y capacidad de subida', bitrate: 'Bitrate del programa', mediamtx: 'Servicio de cámaras',
  overlay: 'Marcador del programa', authorization: 'Autorización', destination: 'Destino preparado',
};
export type PreflightOutcome = Pick<PilotPreflightCheck, 'message'> & {
  readonly status: 'pass' | 'warning' | 'blocked' | 'not_applicable';
  readonly checkedAt?: string;
};
export type PreflightMediaOutcome = {
  readonly checks: Readonly<Partial<Record<PilotPreflightCheckId, PreflightOutcome>>>;
  readonly preview: PilotPreflight['preview'];
};

/** Run only the selected check; media checks share one inseparable composed-program sample. */
export async function runPilotPreflight(options: {
  readonly previous?: PilotPreflight | null;
  readonly check?: PilotPreflightCheckId;
  readonly signal: AbortSignal;
  readonly metadata: (id: PilotPreflightCheckId) => Promise<PreflightOutcome>;
  readonly media: (runId: string) => Promise<PreflightMediaOutcome>;
  readonly onUpdate: (report: PilotPreflight) => void;
}): Promise<PilotPreflight> {
  const startedAt = new Date().toISOString();
  const selected = options.check ? MEDIA_CHECKS.includes(options.check) ? MEDIA_CHECKS : [options.check] : PilotPreflightCheckIdSchema.options;
  let report = PilotPreflightSchema.parse({ id: randomUUID(), status: 'running', startedAt,
    finishedAt: null, validUntil: null,
    preview: selected.some((id) => MEDIA_CHECKS.includes(id)) ? null : options.previous?.preview ?? null,
    checks: PilotPreflightCheckIdSchema.options.map((id) => selected.includes(id)
      ? { id, label: LABELS[id], status: 'running', message: 'Comprobando…', checkedAt: null }
      : options.previous?.checks.find((check) => check.id === id)
        ?? { id, label: LABELS[id], status: 'pending', message: 'Todavía no se ha comprobado.', checkedAt: null }),
  });
  const publish = () => options.onUpdate(report);
  const set = (id: PilotPreflightCheckId, outcome: PreflightOutcome) => {
    report = { ...report, checks: report.checks.map((check) => check.id === id
      ? { ...check, ...outcome, checkedAt: outcome.checkedAt ?? new Date().toISOString() } : check) };
    publish();
  };
  publish();
  await Promise.all(selected.filter((id) => !MEDIA_CHECKS.includes(id)).map(async (id) => {
    try { set(id, await boundedCheck(() => options.metadata(id), options.signal)); }
    catch { set(id, { status: 'blocked', message: 'No se pudo completar esta comprobación. Revisa la conexión o el servicio y vuelve a intentarlo.' }); }
  }));
  if (selected.some((id) => MEDIA_CHECKS.includes(id)) && !options.signal.aborted) {
    const prerequisites = report.checks.filter((check) => ['configuration', 'storage', 'authorization', 'profile', 'mediamtx'].includes(check.id)
      && check.status === 'blocked');
    if (prerequisites.length) {
      report = { ...report, checks: report.checks.map((check) => MEDIA_CHECKS.includes(check.id)
        ? { ...check, status: 'pending', checkedAt: new Date().toISOString(),
          message: `Prueba omitida por: ${prerequisites.map(({ label }) => label).join(', ')}. No se ha evaluado este resultado.` } : check) };
      publish();
    } else {
      try {
        const result = await options.media(report.id);
        report = { ...report, preview: result.preview };
        for (const id of MEDIA_CHECKS) set(id, result.checks[id]
          ?? { status: 'blocked', message: 'La prueba del programa no produjo un resultado válido.' });
      } catch {
        for (const id of MEDIA_CHECKS) set(id, { status: 'blocked', message: 'No se pudo completar la prueba del programa. Revisa cámara, marcador y encoder y vuelve a intentarlo.' });
      }
    }
  }
  const finishedAt = new Date().toISOString();
  const oldest = Math.min(...report.checks.map((check) => check.checkedAt ? Date.parse(check.checkedAt) : 0));
  const validUntil = new Date(oldest + PREFLIGHT_LIFETIME_MS).toISOString();
  const incomplete = report.checks.some((check) => ['blocked', 'running', 'pending'].includes(check.status));
  const status = options.signal.aborted ? 'cancelled' : incomplete || !report.preview ? 'blocked'
    : Date.parse(validUntil) <= Date.now() ? 'stale'
      : report.checks.some((check) => check.status === 'warning') ? 'warning' : 'ready';
  report = PilotPreflightSchema.parse({ ...report, status, finishedAt,
    validUntil: ['ready', 'warning'].includes(status) ? validUntil : null,
    checks: report.checks.map((check) => check.status === 'running'
      ? { ...check, status: 'blocked', message: 'Comprobación cancelada; vuelve a intentarlo.', checkedAt: finishedAt } : check),
  });
  publish();
  return report;
}

function boundedCheck<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Preflight check cancelled')); };
    const timeout = setTimeout(abort, 20_000); timeout.unref();
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void action().then((result) => { cleanup(); resolve(result); }, (error: unknown) => { cleanup(); reject(error); });
  });
}
