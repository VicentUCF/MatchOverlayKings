import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PilotMobileRuntimeEvent } from './pilot-mobile-events.js';
import { z } from 'zod';
import { PilotConfigurationSchema, PilotIncidentSchema, PilotOperationSchema, PilotSessionSchema,
  type PilotConfiguration, type PilotIncident, type PilotOperation, type PilotSession } from '@kpl/production-contracts';

const ResultSchema = z.union([PilotSessionSchema, PilotConfigurationSchema]);
const EntrySchema = z.strictObject({
  operation: PilotOperationSchema,
  fingerprint: z.string().length(64),
  result: ResultSchema.nullable(),
  externalEffectStarted: z.boolean().default(true),
});
const JournalSchema = z.strictObject({ version: z.literal(1), entries: z.array(EntrySchema), incidents: z.array(PilotIncidentSchema).default([]) });
type Entry = z.infer<typeof EntrySchema>;
type Result = z.infer<typeof ResultSchema>;
type Context = Pick<PilotOperation, 'kind' | 'courtSlug' | 'sessionId' | 'matchdayNumber' | 'seasonLabel'>;

export class PilotOperationError extends Error {
  public readonly statusCode = 409;
  public constructor(message: string, public readonly code = 'CONFLICT') { super(message); }
}

/** Separate write-ahead journal. It never stores input payloads, credentials or raw errors. */
export class PilotOperationJournal {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Promise<Result>>();
  private writes: Promise<void> = Promise.resolve();
  private readonly incidents: PilotIncident[] = [];

  public constructor(private readonly path: string) {}

  public async initialize(): Promise<void> {
    let saved: z.infer<typeof JournalSchema>;
    try {
      saved = JournalSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw new Error('No se pudo leer el registro de operaciones. Conserva el archivo para recuperar el estado.');
    }
    for (const entry of saved.entries) {
      if (this.entries.has(entry.operation.id)) throw new Error('El registro contiene operaciones duplicadas.');
      this.entries.set(entry.operation.id, entry.operation.status === 'pending' ? {
        ...entry, operation: {
          ...entry.operation, status: 'interrupted', updatedAt: new Date().toISOString(),
          message: 'El servicio se reinició antes de confirmar esta operación. Comprueba el estado de la pista antes de actuar.',
        },
      } : entry);
    }
    this.incidents.push(...saved.incidents);
    await this.persist();
  }

  public list(): readonly PilotOperation[] {
    return [...this.entries.values()].map(({ operation }) => operation);
  }

  public incidentHistory(): readonly PilotIncident[] { return [...this.incidents]; }

  public async recordMobileRuntime(event: PilotMobileRuntimeEvent, context: {
    readonly sessionId: string | null;
    readonly status: PilotSession['status'] | null;
    readonly operationId: string | null;
    readonly matchdayNumber: number | null;
    readonly seasonLabel: string | null;
  }): Promise<void> {
    if (this.incidents.some(({ id }) => id === event.id)) return;
    const previous = this.incidents.findLast((incident) => incident.category === 'mobile_runtime' && incident.mobileSessionId === event.mobileSessionId);
    if (previous?.mobileRuntimeCode === event.code && previous.attempt === event.attempt && previous.sessionId === context.sessionId) return;
    const messages: Record<PilotMobileRuntimeEvent['code'], string> = {
      starting: 'Se está iniciando el servicio de cámaras. Todavía no confirma señal móvil.',
      ready: 'El servicio de cámaras responde. Cada móvil debe confirmar su perfil y señal.',
      restored: 'El servicio de cámaras vuelve a responder. Se ha solicitado a cada móvil que confirme de nuevo su perfil y señal.',
      process_exit: 'El proceso del servicio de cámaras se detuvo inesperadamente. Se inicia su recuperación.',
      unresponsive: 'El servicio de cámaras falló tres comprobaciones seguidas. Se reinicia para recuperar la señal.',
      start_failed: 'No se pudo habilitar el servicio de cámaras. Revisa la entrada móvil y su configuración.',
      retry_scheduled: 'Se ha programado otro intento de recuperación del servicio de cámaras.',
      retrying: 'Se está reintentando el inicio del servicio de cámaras.',
      exhausted: 'El servicio de cámaras no se recuperó tras cinco intentos. Revisa el servicio y pulsa Recuperar emisión; si no hay emisión, renueva el enlace móvil.',
      manual_recovery: 'Se ha solicitado recuperar manualmente el servicio de cámaras.',
      configuration_unavailable: 'Se conservan los enlaces de cámara, pero MediaMTX o la configuración de red no están disponibles. Revisa los ajustes del equipo.',
      revocation_restart: 'Se reinicia el servicio de cámaras porque no pudo retirar una conexión revocada. Las otras cámaras volverán a confirmar su señal.',
    };
    const resolved = event.code === 'ready' || event.code === 'restored';
    const severity = ['exhausted', 'configuration_unavailable'].includes(event.code) ? 'critical'
      : ['starting', 'ready', 'restored', 'manual_recovery'].includes(event.code) ? 'info' : 'warning';
    const incident = PilotIncidentSchema.parse({ ...context,
      id: event.id, courtSlug: event.courtSlug, category: 'mobile_runtime', mobileSessionId: event.mobileSessionId,
      mobileRuntimeCode: event.code, attempt: event.attempt, resolved, previousStatus: context.status,
      createdAt: event.createdAt, severity,
      message: `${messages[event.code]}${event.attempt > 0 ? ` Intento ${event.attempt}/5.` : ''}`,
    });
    this.incidents.push(incident);
    try { await this.persist(); }
    catch (error) { this.incidents.splice(this.incidents.indexOf(incident), 1); throw error; }
  }

  public correlationId(session: PilotSession): string | null {
    return [...this.entries.values()].findLast(({ operation }) => operation.sessionId === session.id
      || (operation.courtSlug === session.courtSlug && operation.kind === 'prepare' && operation.status === 'pending'))?.operation.id ?? null;
  }

  public async reconcileSessions(sessions: readonly { readonly public: PilotSession; readonly preparationOperationId?: string | undefined }[]): Promise<void> {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (!['interrupted', 'failed'].includes(entry.operation.status) || ['configure', 'preflight'].includes(entry.operation.kind)) continue;
      if (entry.operation.status === 'failed' && entry.operation.kind !== 'prepare') continue;
      const session = sessions.find((session) => entry.operation.kind === 'prepare'
        ? session.preparationOperationId === id : session.public.id === entry.operation.sessionId);
      if (!session) continue;
      if (entry.operation.kind === 'prepare' && session.public.preparationPending) continue;
      // A durable session identifies the original target. A retry can return its
      // current state without repeating a remote mutation or launching an encoder.
      this.entries.set(id, { ...entry, result: session.public, operation: {
        ...entry.operation, sessionId: session.public.id, status: 'completed', updatedAt: new Date().toISOString(),
        message: 'Operación reconciliada con la sesión conservada. Consulta su estado actual para recuperar o finalizar.',
      } });
      changed = true;
    }
    if (changed) await this.persist();
  }

  public assertNoUnresolvedPreparation(courtSlug: string): void {
    const pending = [...this.entries.values()].find(({ operation, externalEffectStarted }) => operation.courtSlug === courtSlug
      && operation.kind === 'prepare' && ['interrupted', 'failed'].includes(operation.status) && externalEffectStarted);
    if (pending) throw new PilotOperationError(`La pista tiene una preparación interrumpida sin sesión confirmada. Hay que comprobar el destino antes de crear otro directo. Diagnóstico: ${pending.operation.id}.`, 'OPERATION_INTERRUPTED');
  }

  public async markExternalEffect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.operation.status !== 'pending') throw new PilotOperationError('No existe una operación pendiente para preparar el destino.');
    this.entries.set(id, { ...entry, externalEffectStarted: true });
    await this.persist();
  }

  public async reconcileConfigurations(configurations: readonly PilotConfiguration[]): Promise<void> {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.operation.status !== 'interrupted' || entry.operation.kind !== 'configure') continue;
      const configuration = configurations.find(({ courtSlug }) => courtSlug === entry.operation.courtSlug);
      if (!configuration) continue;
      const input = Object.fromEntries(Object.entries(configuration).filter(([key]) => key !== 'updatedAt'));
      const { kind, courtSlug, sessionId, matchdayNumber, seasonLabel } = entry.operation;
      const fingerprint = createHash('sha256').update(canonical({ context: { kind, courtSlug, sessionId, matchdayNumber, seasonLabel }, input })).digest('hex');
      if (fingerprint !== entry.fingerprint) continue;
      this.entries.set(id, { ...entry, result: configuration, operation: {
        ...entry.operation, status: 'completed', updatedAt: new Date().toISOString(),
        message: 'La configuración solicitada está conservada. El partido se volverá a comprobar al iniciar la emisión.',
      } });
      changed = true;
    }
    if (changed) await this.persist();
  }

  public async recordState(session: PilotSession, matchdayNumber: number | null, seasonLabel: string | null,
    observed = { operationId: this.correlationId(session), createdAt: new Date().toISOString() }): Promise<void> {
    const previous = this.incidents.findLast((incident) => incident.sessionId === session.id && incident.category === 'state');
    const messages: Record<PilotSession['status'], string> = {
      preparing: 'Se está preparando el destino. Todavía no se ha iniciado la emisión.',
      prepared: 'La emisión está preparada.', starting: 'Esperando confirmación de señal y destino.',
      live: 'Emisión confirmada.', reconnecting: 'Se está recuperando la señal.', interrupted: 'La emisión necesita recuperación tras un reinicio.',
      stopping: 'Se está cerrando la emisión.', stopped: 'Emisión finalizada.', failed: 'La emisión necesita atención.',
    };
    const message = (session.error ?? messages[session.status]).slice(0, 500);
    if (previous?.status === session.status && previous.message === message) return;
    const incident = PilotIncidentSchema.parse({
      id: randomUUID(), sessionId: session.id, operationId: observed.operationId,
      courtSlug: session.courtSlug, matchdayNumber, seasonLabel,
      previousStatus: previous?.status ?? null, status: session.status,
      severity: session.status === 'failed' ? 'critical' : ['interrupted', 'reconnecting'].includes(session.status) ? 'warning' : 'info',
      createdAt: observed.createdAt, message,
    });
    this.incidents.push(incident);
    try { await this.persist(); } catch (error) {
      this.incidents.splice(this.incidents.indexOf(incident), 1);
      throw error;
    }
  }

  public async recordContinuity(session: PilotSession, matchdayNumber: number | null, seasonLabel: string | null,
    observed = { operationId: this.correlationId(session), createdAt: new Date().toISOString() }): Promise<void> {
    const continuity = session.continuity;
    if (!continuity || !['starting', 'live', 'reconnecting', 'failed'].includes(session.status)) return;
    const previous = this.incidents.findLast((incident) => incident.sessionId === session.id && incident.category === 'continuity');
    if (!continuity.active && (!previous || previous.resolved)) return;
    const message = continuity.active
      ? `${continuity.reason ?? 'Se muestra la continuidad mientras vuelve la cámara.'} Intento ${continuity.attempt}/5.`
      : 'La cámara vuelve a entregar señal. Se retira la continuidad sin reiniciar la salida.';
    if (previous?.message === message) return;
    const incident = PilotIncidentSchema.parse({
      id: randomUUID(), category: 'continuity', resolved: !continuity.active,
      sessionId: session.id, operationId: observed.operationId, courtSlug: session.courtSlug, matchdayNumber, seasonLabel,
      previousStatus: session.status, status: session.status,
      severity: continuity.exhausted ? 'critical' : continuity.active ? 'warning' : 'info',
      createdAt: observed.createdAt, message,
    });
    this.incidents.push(incident);
    try { await this.persist(); }
    catch (error) { this.incidents.splice(this.incidents.indexOf(incident), 1); throw error; }
  }

  public async recordOverlay(session: PilotSession, matchdayNumber: number | null, seasonLabel: string | null,
    observed = { operationId: this.correlationId(session), createdAt: new Date().toISOString() }): Promise<void> {
    const health = session.overlayHealth;
    if (!health || !['starting', 'live', 'reconnecting', 'failed'].includes(session.status)) return;
    const previous = this.incidents.findLast((incident) => incident.sessionId === session.id && incident.category === 'overlay');
    const resolved = health.status === 'ready';
    if (resolved && (!previous || previous.resolved)) return;
    const message = resolved ? 'El marcador vuelve a responder. Se reanudan sus imágenes sin reiniciar la salida.'
      : `${health.reason} Intento ${health.attempt}/5.`;
    if (previous?.message === message) return;
    const incident = PilotIncidentSchema.parse({
      id: randomUUID(), category: 'overlay', resolved,
      sessionId: session.id, operationId: observed.operationId, courtSlug: session.courtSlug, matchdayNumber, seasonLabel,
      previousStatus: session.status, status: session.status,
      severity: resolved ? 'info' : health.status === 'failed' ? 'critical' : 'warning', createdAt: observed.createdAt, message,
    });
    this.incidents.push(incident);
    try { await this.persist(); }
    catch (error) { this.incidents.splice(this.incidents.indexOf(incident), 1); throw error; }
  }

  public async recordSignal(session: PilotSession, matchdayNumber: number | null, seasonLabel: string | null,
    observed = { operationId: this.correlationId(session), createdAt: new Date().toISOString() }): Promise<void> {
    if (!session.signal || session.signal.checking) return;
    const latest = new Map(this.incidents.filter((incident) => incident.sessionId === session.id && incident.category === 'signal' && incident.signalCode)
      .map((incident) => [incident.signalCode!, incident]));
    const current = new Map(session.signal.issues.map((issue) => [issue.code, issue]));
    const changes: PilotIncident[] = [];
    for (const code of new Set([...latest.keys(), ...current.keys()])) {
      const issue = current.get(code);
      const previous = latest.get(code);
      if ((issue && previous?.resolved === false) || (!issue && (!previous || previous.resolved))) continue;
      changes.push(PilotIncidentSchema.parse({
        id: randomUUID(), category: 'signal', signalCode: code, resolved: !issue,
        sessionId: session.id, operationId: observed.operationId, courtSlug: session.courtSlug, matchdayNumber, seasonLabel,
        previousStatus: session.status, status: session.status, severity: issue ? 'warning' : 'info',
        createdAt: observed.createdAt, message: issue?.message ?? `Aviso resuelto: ${previous!.message}`,
      }));
    }
    if (changes.length === 0) return;
    this.incidents.push(...changes);
    try { await this.persist(); }
    catch (error) {
      for (const incident of changes) this.incidents.splice(this.incidents.indexOf(incident), 1);
      throw error;
    }
  }

  public async execute<T extends Result>(
    id: string | undefined, context: Context, input: unknown, action: () => Promise<T>,
  ): Promise<T> {
    const key = id ?? randomUUID();
    if (!z.uuid().safeParse(key).success) throw new PilotOperationError('El identificador de operación debe ser un UUID.');
    const fingerprint = createHash('sha256').update(canonical({ context, input })).digest('hex');
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PilotOperationError('Este identificador ya pertenece a otra operación.');
      const inFlight = this.running.get(key);
      if (inFlight) return await inFlight as T;
      if (existing.operation.status === 'completed' && existing.result !== null) return existing.result as T;
      throw new PilotOperationError(`Operación ${key}: ${existing.operation.message ?? 'Comprueba el estado conservado de la pista.'}`,
        existing.operation.status === 'interrupted' ? 'OPERATION_INTERRUPTED' : 'CONFLICT');
    }
    const now = new Date().toISOString();
    const entry: Entry = { fingerprint, result: null, externalEffectStarted: false, operation: {
      ...context, id: key, status: 'pending', createdAt: now, updatedAt: now, message: null,
    } };
    this.entries.set(key, entry);
    const execution = this.perform(key, entry, action);
    this.running.set(key, execution);
    try { return await execution; } finally { this.running.delete(key); }
  }

  private async perform<T extends Result>(key: string, entry: Entry, action: () => Promise<T>): Promise<T> {
    // Never invoke the external action unless the intent reached durable storage.
    try { await this.persist(); } catch (error) { this.entries.delete(key); throw error; }
    let result: T;
    try { result = await action(); } catch (error) {
      const current = this.entries.get(key) ?? entry;
      this.entries.set(key, { ...current, operation: { ...entry.operation, status: 'failed',
        updatedAt: new Date().toISOString(), message: current.externalEffectStarted
          ? 'El resultado remoto no está confirmado. Hay que comprobar el destino antes de preparar otra emisión.'
          : 'La operación no se completó. Comprueba la pista y su destino antes de reintentar.',
      } });
      await this.persist();
      throw error;
    }
    const safeResult = ResultSchema.parse(result);
    const current = this.entries.get(key) ?? entry;
    this.entries.set(key, { ...current, result: safeResult, operation: {
      ...entry.operation, status: 'completed', updatedAt: new Date().toISOString(),
      sessionId: 'id' in safeResult ? safeResult.id : null,
    } });
    try { await this.persist(); } catch (error) {
      this.entries.set(key, { ...current, operation: { ...entry.operation, status: 'interrupted',
        updatedAt: new Date().toISOString(), message: 'La acción se ejecutó, pero no se pudo guardar su confirmación. Comprueba la pista.',
      } });
      throw error;
    }
    return result;
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify(JournalSchema.parse({ version: 1, entries: [...this.entries.values()], incidents: this.incidents }));
    const write = async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(`${payload}\n`); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    };
    const pending = this.writes.then(write);
    this.writes = pending.catch(() => undefined);
    return pending;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
