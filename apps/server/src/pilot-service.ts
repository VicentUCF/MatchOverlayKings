import { pilotProgramCommand } from './pilot-program-command.js';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkPilotMetadata, checkPilotMedia } from './pilot-preflight-checks.js';
import { runPilotPreflight } from './pilot-preflight.js';
import { measurePilotHost, checkIngestTransport } from './pilot-preflight-system.js';
import { probePilotMedia } from './pilot-preflight-media.js';
import { PilotUploadCheck, type measurePilotUpload } from './pilot-upload-check.js';
import { writePrivateJson } from './private-json.js';
import type { Readable, Writable } from 'node:stream';
import { createProductionAssets, renderContinuityFrame } from '@kpl/production-assets';
import { PilotProgramFeed, type ProgramFeed, type ProgramFeedOptions } from './pilot-program-feed.js';
import {
  PilotSourceSchema,
  PILOT_MOBILE_SOURCE_ID,
  PilotReadinessSchema,
  PilotConfigurationSchema,
  PilotConfigurationsSchema,
  PilotSessionSchema,
  PreparePilotSessionInputSchema,
  RunPilotPreflightInputSchema,
  type PilotPreflightCheckId,
  type PilotEncoderHealth,
  type PilotConfiguration,
  type PilotCourtSlug,
  type PilotReadiness,
  type PilotSession,
  type PilotSource,
  type PilotVideoEncoder,
  type PreparePilotSessionInput,
} from '@kpl/production-contracts';
import { z } from 'zod';
import { PilotSignalMonitor } from './pilot-signal-monitor.js';
import { PilotOperationJournal } from './pilot-operation-journal.js';
import { observeYouTubeSession } from './pilot-observed-state.js';
import { encoderProcessIdentity, stopOrphanedEncoder } from './pilot-process-identity.js';
import { YouTubePreparationSchema, type YouTubePreparation } from './pilot-youtube-preparation.js';
import type { PilotMatchBinding } from './pilot-match-binding.js';
import type { PilotStreamLink } from './pilot-stream-link.js';
import { PilotYouTubeError } from './pilot-youtube.js';
import type { PilotYouTubeGateway } from './pilot-youtube.js';
import type { PilotMobileCameraService } from './pilot-mobile-camera.js';
import type { PilotMobileRuntimeEvent } from './pilot-mobile-events.js';
import type { PilotOverlayOptions, PilotOverlayRenderer } from './pilot-overlay.js';
import {
  CPU_ENCODER, detectVideoEncoders, encoderKey,
  ffmpegEnvironment, isHardwareEncoderFailure, selectVideoEncoder,
} from './pilot-video-encoder.js';

const MAX_ACTIVE_SESSIONS = 3;
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const MAX_AUTOMATIC_RETRIES = 5;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

const PersistedPilotSessionSchema = z.strictObject({
  public: PilotSessionSchema,
  thumbnailBase64: z.string(),
  streamId: z.string().nullable(),
  ingestUrl: z.string().nullable(),
  source: PilotSourceSchema,
  rejectedEncoders: z.array(z.string()).optional(),
  remoteStopPending: z.boolean().optional(),
  runtimeProcess: z.strictObject({ pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), bootId: z.uuid().optional() }).nullable().optional(),
  captureProcess: z.strictObject({ pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), bootId: z.uuid().optional() }).nullable().optional(),
  previewEncoder: z.strictObject({ pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), bootId: z.uuid().optional() }).nullable().optional(),
  previewCapture: z.strictObject({ pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), bootId: z.uuid().optional() }).nullable().optional(),
  configuration: PreparePilotSessionInputSchema.optional(),
  preparationOperationId: z.uuid().optional(),
  preparation: YouTubePreparationSchema.optional(),
  overlay: z.strictObject({
    courtSlug: PilotSessionSchema.shape.courtSlug,
    homeTeamId: z.string().min(1).optional(),
    awayTeamId: z.string().min(1).optional(),
  }),
});

const PersistedPilotSessionsSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(PersistedPilotSessionSchema),
});

type InternalPilotSession = {
  public: PilotSession;
  readonly thumbnail: Uint8Array;
  streamId: string | null;
  ingestUrl: string | null;
  process: PilotChildProcess | null;
  retryTimer: NodeJS.Timeout | null;
  retryAttempt: number;
  diagnostic: string;
  lastYouTubeCheckAt: number;
  readonly overlay: Omit<PilotOverlayOptions, 'framesPerSecond'>;
  overlayController: AbortController | null;
  readonly rejectedEncoders: Set<string>;
  remoteStopPending: boolean;
  readonly configuration: PreparePilotSessionInput | undefined;
  readonly preparationOperationId: string | undefined;
  preparation: YouTubePreparation | undefined;
  program: ProgramFeed | null;
  fallbackFrame: Uint8Array | null;
};

type PilotChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type PilotPreflightDependencies = {
  readonly media?: typeof probePilotMedia;
  readonly host?: typeof measurePilotHost;
  readonly transport?: typeof checkIngestTransport;
  readonly upload?: typeof measurePilotUpload;
};

export class PilotServiceError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_READY' | 'RUNTIME_ERROR' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'PilotServiceError';
  }
}

export class PilotService {
  private readonly sessions = new Map<string, InternalPilotSession>();
  private readonly configurationByCourt = new Map<PilotCourtSlug, PilotConfiguration>();
  private readonly changingCourts = new Set<string>();
  private readonly preparingSources = new Set<string>();
  private readonly courtCompletions = new Map<string, Promise<void>>();
  private readonly preparingSessions = new Map<string, { controller: AbortController; task: Promise<PilotSession> }>();
  private ffmpegVersion: string | null = null;
  private videoEncoders: readonly PilotVideoEncoder[] = [CPU_ENCODER];
  private persistQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownTask: Promise<void> | null = null;
  private readonly operations: PilotOperationJournal;
  private healthTimer: NodeJS.Timeout | null = null;
  private persistenceError: string | null = null;
  private stopMobileObserver: (() => void) | null = null;
  private readonly pendingMobileIncidents: Array<{
    event: PilotMobileRuntimeEvent;
    context: Parameters<PilotOperationJournal['recordMobileRuntime']>[1];
  }> = [];
  private readonly checkingSessions = new Map<string, { controller: AbortController; task: Promise<PilotSession> }>();
  private readonly checkedContexts = new Map<string, string>();
  private readonly previewProcesses = new Map<string, { encoder: number | undefined; capture: number | undefined }>();
  private readonly uploadCheck: PilotUploadCheck;

  public constructor(
    private readonly ffmpegPath: string,
    private readonly youtube: PilotYouTubeGateway,
    private readonly configurationPath: string,
    private readonly mobileCamera?: PilotMobileCameraService,
    private readonly overlayRenderer?: PilotOverlayRenderer,
    private readonly matchBinding?: PilotMatchBinding,
    private readonly streamLink?: PilotStreamLink,
    private readonly programFactory: (options: ProgramFeedOptions) => ProgramFeed = (options) => new PilotProgramFeed(options),
    private readonly preflightDependencies: PilotPreflightDependencies = {},
  ) {
    this.operations = new PilotOperationJournal(`${configurationPath}.operations`);
    this.uploadCheck = new PilotUploadCheck(preflightDependencies.upload);
  }

  public operationHistory() { return this.operations.list(); }
  public incidentHistory() { return this.operations.incidentHistory(); }

  public async initialize(): Promise<void> {
    await this.youtube.initialize();
    await this.loadConfigurations();
    await this.loadSessions();
    await this.operations.initialize();
    this.stopMobileObserver = this.mobileCamera?.observeRuntime((event) => this.mobileRuntimeChanged(event)) ?? null;
    const probe = spawnSync(this.ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 5_000 });
    this.ffmpegVersion = probe.status === 0
      ? probe.stdout.split(/\r?\n/, 1)[0]?.trim() || null
      : null;
    if (this.ffmpegVersion !== null) this.videoEncoders = await detectVideoEncoders(this.ffmpegPath);
    await Promise.all([...this.sessions.values()].map(async (session) => {
      if (!session.public.preparationPending || !session.preparation) return;
      try {
        await this.youtube.inspectPreparation(session.preparation, (state) => this.savePreparation(session, state));
        if (session.preparation.ready && !session.remoteStopPending) {
          session.public = PilotSessionSchema.parse({ ...session.public, status: 'prepared', preparationPending: false, error: null });
        }
      } catch {
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'interrupted',
          error: 'No se pudo reconciliar toda la preparación con YouTube. Conservamos sus datos; pulsa Recuperar preparación o Finalizar sesión.',
        });
      }
    }));
    await Promise.all([...this.sessions.values()].map((session) => this.refreshYouTubeHealth(session)));
    await this.operations.reconcileSessions([...this.sessions.values()]);
    await this.operations.reconcileConfigurations(this.configurations());
    await this.persistSessions();
    this.healthTimer = setInterval(() => {
      if (this.pendingMobileIncidents.length > 0) this.queuePersistSessions();
      void Promise.all([...this.sessions.values()].filter(({ public: session }) => session.status !== 'stopped')
        .map((session) => this.refreshYouTubeHealth(session)));
    }, 5_000);
    this.healthTimer.unref();
  }

  /** Complete initial runtime observations before exposing the control API. */
  public async flushOperationalHistory(): Promise<void> { await this.persistSessions(); }

  private mobileRuntimeChanged(event: PilotMobileRuntimeEvent): void {
    if (this.shuttingDown) return;
    const session = [...this.sessions.values()].findLast(({ public: current }) => current.courtSlug === event.courtSlug
      && current.source.kind === 'mobile' && current.status !== 'stopped');
    const configuration = session?.configuration ?? this.configurationByCourt.get(event.courtSlug);
    const operationId = session ? this.operations.correlationId(session.public)
      : this.operations.list().findLast((operation) => operation.courtSlug === event.courtSlug && operation.kind === 'configure')?.id ?? null;
    this.pendingMobileIncidents.push({ event, context: {
      sessionId: session?.public.id ?? null, status: session?.public.status ?? null, operationId,
      matchdayNumber: configuration?.matchdayNumber ?? null, seasonLabel: configuration?.seasonLabel ?? null,
    } });
    this.queuePersistSessions();
  }

  public configurations(): readonly PilotConfiguration[] {
    return PilotConfigurationsSchema.parse([...this.configurationByCourt.values()]);
  }

  public async configure(rawCourtSlug: unknown, rawInput: unknown, authorization?: string, operationId?: string): Promise<PilotConfiguration> {
    const input = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!input.success || input.data.courtSlug !== rawCourtSlug) {
      throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa la configuración de la pista.');
    }
    const source = this.readiness().sources.find(({ id }) => id === input.data.sourceId);
    if (source === undefined) {
      throw new PilotServiceError(409, 'NOT_READY', 'La fuente seleccionada ya no está disponible.');
    }
    const configuration = PilotConfigurationSchema.parse({
      ...input.data,
      updatedAt: new Date().toISOString(),
    });
    return this.operations.execute(operationId, {
      kind: 'configure', courtSlug: configuration.courtSlug, sessionId: null,
      matchdayNumber: configuration.matchdayNumber, seasonLabel: configuration.seasonLabel,
    }, input.data, () => this.changeCourt(configuration.courtSlug, async () => {
      if (this.hasOpenSession(configuration.courtSlug)) throw new PilotServiceError(409, 'CONFLICT', 'Detén la emisión preparada o activa antes de cambiar el partido.');
      if (!this.matchBinding) throw new PilotServiceError(503, 'NOT_READY', 'No se puede vincular el partido con el marcador.');
      await this.matchBinding.configure(configuration, authorization);
      const previous = this.configurationByCourt.get(configuration.courtSlug);
      this.configurationByCourt.set(configuration.courtSlug, configuration);
      try { await this.persistConfigurations(); } catch (error) {
        if (previous) this.configurationByCourt.set(configuration.courtSlug, previous);
        else this.configurationByCourt.delete(configuration.courtSlug);
        throw error;
      }
      return configuration;
    }));
  }

  public readiness(): PilotReadiness {
    const mobileSource = this.mobileCamera?.source() ?? null;
    const sources = [...discoverSources(), ...(mobileSource === null ? [] : [mobileSource])];
    const limitations: string[] = [];
    if (this.persistenceError !== null) limitations.push(this.persistenceError);
    if (sources.every(({ kind }) => kind !== 'v4l2')) limitations.push('No se detectan cámaras V4L2. Puedes validar con la señal sintética.');
    if (!this.youtube.configured) limitations.push('Faltan las credenciales OAuth de Google para probar YouTube.');
    else if (!this.youtube.isAuthorized) limitations.push('La cuenta de YouTube todavía no está conectada.');
    const mobileLimitation = this.mobileCamera?.limitation() ?? 'La cámara móvil no está configurada.';
    if (mobileLimitation !== null) limitations.push(mobileLimitation);
    if (this.ffmpegVersion !== null && !this.videoEncoders.some(({ hardware }) => hardware)) {
      limitations.push('Codificación por CPU: ninguna GPU ha superado la prueba. Comprueba los controladores y el acceso a la GPU desde Docker.');
    }
    return PilotReadinessSchema.parse({
      ffmpeg: { available: this.ffmpegVersion !== null, version: this.ffmpegVersion, encoders: this.videoEncoders },
      youtube: {
        configured: this.youtube.configured,
        authorized: this.youtube.isAuthorized,
        authorizationUrl: this.youtube.configured ? '/api/pilot/youtube/auth/start' : null,
      },
      sources,
      limitations,
    });
  }

  public authorizationUrl(): string {
    return this.youtube.createAuthorizationUrl();
  }

  public async completeAuthorization(code: string, state: string): Promise<void> {
    try {
      await this.youtube.completeAuthorization(code, state);
    } catch (error) {
      throw mapYouTubeError(error);
    }
  }

  private hasOpenSession(courtSlug: string): boolean {
    return [...this.sessions.values()].some(({ public: session }) => session.courtSlug === courtSlug && session.status !== 'stopped');
  }

  private async changeCourt<T>(courtSlug: string, operation: () => Promise<T>): Promise<T> {
    if (this.changingCourts.has(courtSlug)) throw new PilotServiceError(409, 'CONFLICT', 'La pista está guardando o preparando una emisión. Espera y vuelve a intentarlo.');
    this.changingCourts.add(courtSlug);
    let finish!: () => void;
    this.courtCompletions.set(courtSlug, new Promise((resolve) => { finish = resolve; }));
    try { return await operation(); } finally {
      this.changingCourts.delete(courtSlug);
      this.courtCompletions.delete(courtSlug);
      finish();
    }
  }

  public async prepare(rawInput: unknown, authorization?: string, operationId?: string): Promise<PilotSession> {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos del directo.');
    const preparationOperationId = operationId ?? randomUUID();
    const result = await this.operations.execute(preparationOperationId, {
      kind: 'prepare', courtSlug: parsed.data.courtSlug, sessionId: null,
      matchdayNumber: parsed.data.matchdayNumber, seasonLabel: parsed.data.seasonLabel,
    }, parsed.data, () => this.changeCourt(parsed.data.courtSlug, async () => {
      const exclusiveSource = parsed.data.sourceId.startsWith('v4l2:');
      if (exclusiveSource && this.preparingSources.has(parsed.data.sourceId)) {
        throw new PilotServiceError(409, 'CONFLICT', 'Otra pista está preparando esta cámara. Espera o selecciona otra fuente.');
      }
      if (exclusiveSource) this.preparingSources.add(parsed.data.sourceId);
      try { return await this.prepareCourt(parsed.data, authorization, preparationOperationId); }
      finally { if (exclusiveSource) this.preparingSources.delete(parsed.data.sourceId); }
    }));
    return this.get(result.id).public;
  }

  private async prepareCourt(rawInput: unknown, authorization: string | undefined, preparationOperationId: string): Promise<PilotSession> {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos del directo.');
    const input = parsed.data;
    this.operations.assertNoUnresolvedPreparation(input.courtSlug);
    if (this.ffmpegVersion === null) throw new PilotServiceError(503, 'NOT_READY', 'FFmpeg no está disponible.');
    const source = this.readiness().sources.find(({ id }) => id === input.sourceId);
    if (source === undefined) throw new PilotServiceError(409, 'NOT_READY', 'La fuente seleccionada ya no está disponible.');
    if (input.mode === 'youtube' && Date.parse(input.scheduledAt) <= Date.now()) {
      throw new PilotServiceError(
        409,
        'NOT_READY',
        'Actualiza la fecha y hora: YouTube exige programar la emisión para un momento futuro.',
      );
    }
    if (source.kind === 'mobile' && !this.mobileCamera?.isReadyForCourt(input.courtSlug)) {
      throw new PilotServiceError(409, 'NOT_READY', 'Prepara primero la cámara móvil para esta pista.');
    }
    if (source.kind === 'v4l2') {
      const sourceInUse = [...this.sessions.values()].some(({ public: session }) =>
        session.source.id === source.id && session.status !== 'stopped');
      if (sourceInUse) throw new PilotServiceError(409, 'CONFLICT', 'La cámara seleccionada ya está asignada a otra pista.');
    }
    const existing = [...this.sessions.values()].find(({ public: session }) =>
      session.courtSlug === input.courtSlug && session.status !== 'stopped');
    if (existing !== undefined) throw new PilotServiceError(409, 'CONFLICT', 'La pista ya tiene una sesión activa.');

    if (!this.matchBinding) throw new PilotServiceError(503, 'NOT_READY', 'No se puede comprobar el partido del marcador.');
    const identity = await this.matchBinding.assertConfigured(input, authorization);
    const generatedAssets = productionAssets(input);
    const assets = {
      ...generatedAssets,
      description: input.description ?? generatedAssets.description,
    };
    if (input.mode === 'youtube' && (!this.youtube.configured || !this.youtube.isAuthorized)) {
      throw new PilotServiceError(409, 'NOT_READY', 'Conecta primero la cuenta de YouTube.');
    }
    const id = randomUUID();
    const session = PilotSessionSchema.parse({
      id,
      courtSlug: input.courtSlug,
      mode: input.mode,
      source,
      status: input.mode === 'youtube' ? 'preparing' : 'prepared',
      preparationPending: input.mode === 'youtube',
      title: assets.title,
      description: assets.description,
      thumbnailUrl: `/api/pilot/sessions/${id}/thumbnail`,
      broadcastId: null,
      watchUrl: null,
      youtubeStreamStatus: null,
      encoder: null,
      videoEncoding: null,
      encodingWarning: null,
      startedAt: null,
      stoppedAt: null,
      error: null,
    });
    this.sessions.set(id, {
      public: session,
      thumbnail: assets.pngBytes,
      streamId: null,
      ingestUrl: null,
      process: null,
      retryTimer: null,
      retryAttempt: 0,
      diagnostic: '',
      lastYouTubeCheckAt: 0,
      overlay: {
        courtSlug: input.courtSlug,
        ...identity,
      },
      overlayController: null,
      rejectedEncoders: new Set(),
      remoteStopPending: false,
      configuration: input,
      preparationOperationId,
      preparation: input.mode === 'youtube' ? YouTubePreparationSchema.parse({
        operationId: preparationOperationId,
        framesPerSecond: source.kind === 'mobile' ? this.mobileCamera?.framesPerSecondForCourt(input.courtSlug) ?? 30 : 30,
      }) : undefined,
      program: null,
      fallbackFrame: null,
    });
    try {
      await this.persistSessions();
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    if (input.mode === 'youtube') {
      await this.operations.markExternalEffect(preparationOperationId);
      return this.finishPreparation(this.get(id));
    }
    return session;
  }

  private async savePreparation(session: InternalPilotSession, preparation: YouTubePreparation): Promise<void> {
    session.preparation = preparation;
    session.streamId = preparation.streamId;
    session.ingestUrl = preparation.ingestUrl;
    session.public = PilotSessionSchema.parse({ ...session.public, broadcastId: preparation.broadcastId,
      watchUrl: preparation.broadcastId ? `https://www.youtube.com/watch?v=${preparation.broadcastId}` : null,
    });
    await this.persistSessions();
  }

  private finishPreparation(session: InternalPilotSession): Promise<PilotSession> {
    const controller = new AbortController();
    const task = this.runPreparation(session, controller.signal);
    this.preparingSessions.set(session.public.id, { controller, task });
    void task.finally(() => { this.preparingSessions.delete(session.public.id); }).catch(() => undefined);
    return task;
  }

  private async runPreparation(session: InternalPilotSession, signal: AbortSignal): Promise<PilotSession> {
    if (!session.preparation || !session.configuration) throw new PilotServiceError(409, 'NOT_READY', 'No se conserva la preparación necesaria para recuperar este destino.');
    session.public = PilotSessionSchema.parse({ ...session.public, status: 'preparing', error: null, preparationPending: true });
    await this.persistSessions();
    try {
      const prepared = await this.youtube.prepareBroadcast({
        title: session.public.title, description: session.public.description,
        scheduledAt: session.configuration.scheduledAt, privacyStatus: session.configuration.privacyStatus,
        thumbnail: session.thumbnail, framesPerSecond: session.preparation.framesPerSecond,
        recovery: session.preparation, checkpoint: (state) => this.savePreparation(session, state), signal,
      });
      // Persist the final result even when a gateway adapter omits intermediate checkpoints.
      await this.savePreparation(session, YouTubePreparationSchema.parse({ ...session.preparation,
        broadcastId: prepared.broadcastId, streamId: prepared.streamId, ingestUrl: prepared.ingestUrl, ready: true,
      }));
      session.public = PilotSessionSchema.parse({ ...session.public, status: 'prepared', preparationPending: false, error: null });
      await this.persistSessions();
      await this.operations.reconcileSessions([session]);
      return session.public;
    } catch (error) {
      const failure = mapYouTubeError(error);
      session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed', preparationPending: true,
        error: `${failure.message} Puedes recuperar la preparación o finalizar esta sesión desde Mandos.`,
      });
      await this.persistSessions();
      throw failure;
    }
  }

  public async list(): Promise<readonly PilotSession[]> {
    await Promise.all([...this.sessions.values()].map((session) => this.refreshYouTubeHealth(session)));
    for (const session of this.sessions.values()) this.invalidatePreflight(session);
    return [...this.sessions.values()].map(({ public: session }) => session);
  }

  public get(id: string): InternalPilotSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe esa sesión de emisión.');
    return session;
  }

  public async start(id: string, authorization?: string, operationId?: string): Promise<PilotSession> {
    return this.sessionOperation(id, 'start', operationId, () => this.startSession(id, authorization));
  }

  public async preflight(id: string, rawInput: unknown, authorization?: string, operationId?: string): Promise<PilotSession> {
    const parsed = RunPilotPreflightInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa la comprobación solicitada.');
    return this.sessionOperation(id, 'preflight', operationId, async () => {
      const session = this.get(id);
      if (this.shuttingDown || session.public.status !== 'prepared' || session.process !== null) {
        throw new PilotServiceError(409, 'CONFLICT', 'Prepara la sesión antes de comprobar el programa; la prueba requiere una pista detenida.');
      }
      this.assertCapacity(id);
      this.invalidatePreflight(session);
      if (parsed.data.check && (!session.public.preflight || ['stale', 'cancelled'].includes(session.public.preflight.status))) {
        throw new PilotServiceError(409, 'NOT_READY', 'La comprobación anterior ya no está vigente. Repite la comprobación completa.');
      }
      const controller = new AbortController();
      const task = Promise.resolve().then(() => this.checkSession(session, parsed.data.check, authorization, controller.signal));
      this.checkingSessions.set(id, { controller, task });
      try { return await task; } finally { this.checkingSessions.delete(id); }
    }, parsed.data);
  }

  public async cancelPreflight(id: string): Promise<PilotSession> {
    const session = this.get(id);
    const checking = this.checkingSessions.get(id);
    if (checking) {
      const completed = this.courtCompletions.get(session.public.courtSlug);
      checking.controller.abort();
      await Promise.allSettled([checking.task, completed]);
    }
    return session.public;
  }

  public async preflightPreview(id: string, runId: string): Promise<Buffer> {
    const session = this.get(id);
    const url = `/api/pilot/sessions/${id}/preflight-preview/${runId}`;
    if (!z.uuid().safeParse(runId).success || session.public.preflight?.preview?.url !== url
      || session.public.preflight.status === 'running') throw new PilotServiceError(404, 'NOT_FOUND', 'Esta vista previa ya no está disponible. Repite la comprobación del programa.');
    try { return await readFile(join(`${this.configurationPath}.previews`, id, `${runId}.mp4`)); }
    catch { throw new PilotServiceError(404, 'NOT_FOUND', 'No se conserva esta vista previa. Repite la comprobación del programa.'); }
  }

  private preflightContext(session: InternalPilotSession, uploadRevision = this.uploadCheck.revision): string {
    const mobile = session.public.source.kind === 'mobile'
      ? this.mobileCamera?.list().find((camera) => camera.courtSlug === session.public.courtSlug && camera.state !== 'revoked') : null;
    return JSON.stringify({ configuration: session.configuration, overlay: session.overlay, source: session.public.source,
      uploadDemand: session.public.mode === 'youtube' ? this.uploadDemand() : null,
      uploadRevision: session.public.mode === 'youtube' ? uploadRevision : null,
      rejected: [...session.rejectedEncoders], encoders: this.videoEncoders,
      mobile: mobile ? { id: mobile.id, desired: mobile.desired, applied: mobile.applied } : null });
  }

  private uploadDemand(): { kbps: number; courts: number } {
    const rates = new Map<string, number>();
    const add = (court: string, mobile: boolean) => {
      const fps = mobile ? this.mobileCamera?.framesPerSecondForCourt(court) ?? 30 : 30;
      rates.set(court, Math.max(rates.get(court) ?? 0, (fps === 60 ? 9_000 : 6_000) + 128));
    };
    for (const configuration of this.configurationByCourt.values()) {
      if (configuration.mode === 'youtube') add(configuration.courtSlug, configuration.sourceId === PILOT_MOBILE_SOURCE_ID);
    }
    for (const { public: session } of this.sessions.values()) {
      if (session.mode === 'youtube' && session.status !== 'stopped') add(session.courtSlug, session.source.kind === 'mobile');
    }
    const concurrent = [...rates.values()].sort((a, b) => b - a).slice(0, MAX_ACTIVE_SESSIONS);
    return { kbps: concurrent.reduce((sum, rate) => sum + rate, 0), courts: concurrent.length };
  }

  private hasNetworkOutput(): boolean {
    return [...this.sessions.values()].some((session) => session.public.mode === 'youtube'
      && (session.process !== null || ['starting', 'live', 'reconnecting', 'stopping'].includes(session.public.status)));
  }

  private invalidatePreflight(session: InternalPilotSession): void {
    const report = session.public.preflight;
    if (!report || ['running', 'stale', 'cancelled'].includes(report.status)) return;
    const oldest = Math.min(...report.checks.map((check) => Date.parse(check.checkedAt ?? '') || 0));
    if (this.checkedContexts.get(session.public.id) !== this.preflightContext(session) || oldest + 5 * 60_000 <= Date.now()) {
      session.public = { ...session.public, preflight: { ...report, status: 'stale', validUntil: null } };
    }
  }

  private async checkSession(session: InternalPilotSession, check: PilotPreflightCheckId | undefined,
    authorization: string | undefined, signal: AbortSignal): Promise<PilotSession> {
    const id = session.public.id;
    const initialContext = this.preflightContext(session, -1);
    let uploadRevision = this.uploadCheck.revision;
    await mkdir(dirname(this.configurationPath), { recursive: true, mode: 0o700 });
    const mobile = this.mobileCamera?.list().find((camera) => camera.courtSlug === session.public.courtSlug && camera.state !== 'revoked') ?? null;
    const usesMobile = session.public.source.kind === 'mobile';
    const fps = usesMobile ? this.mobileCamera?.framesPerSecondForCourt(session.public.courtSlug) ?? 30 : 30;
    let host: ReturnType<typeof measurePilotHost> | undefined;
    let match: Promise<void> | undefined;
    let destination: ReturnType<PilotYouTubeGateway['health']> | undefined;
    const audioExpected = usesMobile && (this.mobileCamera?.audioExpectedForCourt(session.public.courtSlug) ?? false);
    const previous = session.public.preflight;
    await runPilotPreflight({ ...(previous ? { previous } : {}), ...(check ? { check } : {}), signal,
      metadata: (step) => checkPilotMetadata(step, {
        source: session.public.source, mode: session.public.mode, mobile,
        assertMatch: () => match ??= this.assertSessionMatch(session, authorization),
        host: () => host ??= (this.preflightDependencies.host ?? measurePilotHost)(dirname(this.configurationPath), signal),
        destination: () => destination ??= session.public.broadcastId && session.streamId
          ? this.youtube.health(session.public.broadcastId, session.streamId) : Promise.reject(new Error('Missing destination')),
        transport: () => session.ingestUrl ? (this.preflightDependencies.transport ?? checkIngestTransport)(session.ingestUrl, signal)
          : Promise.reject(new Error('Missing ingest')),
        upload: async () => {
          const measurement = await this.uploadCheck.get(signal, this.hasNetworkOutput(), check === 'network');
          uploadRevision = this.uploadCheck.revision;
          return measurement;
        },
        uploadDemand: this.uploadDemand(),
        mediaMtx: () => this.mobileCamera?.checkRuntimeForCourt(session.public.courtSlug) ?? Promise.resolve(false),
      }),
      media: async (runId) => {
        if (!this.overlayRenderer) throw new Error('Overlay renderer unavailable');
        const directory = join(`${this.configurationPath}.previews`, id);
        await rm(directory, { recursive: true, force: true });
        session.fallbackFrame ??= renderContinuityFrame(courtNameFromSlug(session.public.courtSlug), session.public.title).yuv;
        const encoding = selectVideoEncoder(this.videoEncoders, fps, session.rejectedEncoders);
        const result = await (this.preflightDependencies.media ?? probePilotMedia)({
          path: join(directory, `${runId}.mp4`), renderer: this.overlayRenderer, encoder: encoding,
          overlay: { ...session.overlay, framesPerSecond: fps }, signal, audioExpected,
          source: { executable: this.ffmpegPath, source: session.public.source,
            mobileRtspUrl: usesMobile ? this.mobileCamera?.rtspUrl(session.public.courtSlug) ?? null : null,
            mobileAudioAvailable: usesMobile && (this.mobileCamera?.audioAvailableForCourt(session.public.courtSlug) ?? false),
            sourceReady: () => !usesMobile || this.mobileCamera?.isReadyForCourt(session.public.courtSlug) === true,
            fps, fallback: session.fallbackFrame },
          onProcess: (encoder, capture) => {
            this.previewProcesses.set(id, { encoder: encoder?.pid, capture: capture?.pid }); this.queuePersistSessions();
          },
        });
        if (result.hardwareFailure) {
          session.rejectedEncoders.add(encoderKey(encoding));
          session.public = { ...session.public, encodingWarning: `${encoding.label} falló durante la prueba. Se ha descartado para esta sesión; repite la comprobación completa con el siguiente codificador disponible.` };
        }
        return { checks: checkPilotMedia(result, audioExpected, fps), preview: result.completed
          ? { url: `/api/pilot/sessions/${id}/preflight-preview/${runId}`, durationSeconds: result.durationSeconds, sizeBytes: result.sizeBytes } : null };
      },
      onUpdate: (preflight) => { session.public = { ...session.public, preflight }; this.queuePersistSessions(); },
    });
    if (initialContext === this.preflightContext(session, -1)) this.checkedContexts.set(id, this.preflightContext(session, uploadRevision));
    this.invalidatePreflight(session);
    await this.persistSessions();
    return session.public;
  }

  private async startSession(id: string, authorization?: string): Promise<PilotSession> {
    const session = this.get(id);
    if (session.remoteStopPending) throw new PilotServiceError(409, 'CONFLICT', 'El cierre remoto está pendiente. Finaliza esta sesión antes de iniciar otra vez.');
    if (['starting', 'live'].includes(session.public.status)) return session.public;
    if (session.public.status !== 'prepared') {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no está preparada para emitir.');
    }
    this.invalidatePreflight(session);
    if (!session.public.preflight || !['ready', 'warning'].includes(session.public.preflight.status)) {
      throw new PilotServiceError(409, 'NOT_READY', 'Comprueba el programa antes de emitir y resuelve las comprobaciones bloqueadas.');
    }
    const active = [...this.sessions.values()].filter(({ public: current }) =>
      ['starting', 'live', 'reconnecting', 'stopping'].includes(current.status)).length;
    if (active >= MAX_ACTIVE_SESSIONS) throw new PilotServiceError(409, 'CONFLICT', 'Ya hay tres salidas activas.');
    if (session.public.mode === 'youtube' && session.ingestUrl === null) {
      throw new PilotServiceError(409, 'NOT_READY', 'La entrada de YouTube no está preparada.');
    }

    await this.assertSessionMatch(session, authorization);
    if (session.public.source.kind === 'mobile') {
      await this.mobileCamera?.recoverRuntimeForCourt(session.public.courtSlug);
      if (!this.mobileCamera?.isReadyForCourt(session.public.courtSlug)) {
        throw new PilotServiceError(409, 'NOT_READY', 'La cámara móvil todavía no está lista. Espera a que recupere la señal y vuelve a iniciar.');
      }
    }
    this.assertCapacity(id);

    this.invalidatePreflight(session);
    if (!session.public.preflight || !['ready', 'warning'].includes(session.public.preflight.status)) {
      throw new PilotServiceError(409, 'NOT_READY', 'La comprobación del programa ha caducado o cambió la fuente. Comprueba de nuevo antes de emitir.');
    }
    const host = await (this.preflightDependencies.host ?? measurePilotHost)(dirname(this.configurationPath));
    if (host.availableStorageBytes < 128 * 1024 ** 2 || host.availableMemoryBytes < 256 * 1024 ** 2) {
      const report = session.public.preflight;
      const failed = host.availableStorageBytes < 128 * 1024 ** 2 ? 'storage' : 'memory';
      session.public = { ...session.public, preflight: { ...report, status: 'blocked', validUntil: null,
        checks: report.checks.map((check) => check.id === failed ? { ...check, status: 'blocked',
          checkedAt: new Date().toISOString(), message: 'El margen disponible ha caído desde la comprobación. Libera recursos y repite este paso.' } : check) } };
      await this.persistSessions();
      throw new PilotServiceError(409, 'NOT_READY', 'Falta espacio o memoria para iniciar. Libera recursos y repite la comprobación bloqueada.');
    }
    this.assertCapacity(id);

    this.spawnSessionProcess(session);
    await this.persistSessions();
    await this.publishStreamLink(session, session.public.watchUrl, authorization);
    return session.public;
  }

  public async recover(id: string, authorization?: string, operationId?: string): Promise<PilotSession> {
    return this.sessionOperation(id, 'recover', operationId, () => this.recoverSession(id, authorization));
  }

  private async recoverSession(id: string, authorization?: string): Promise<PilotSession> {
    const session = this.get(id);
    if (session.remoteStopPending) throw new PilotServiceError(409, 'CONFLICT', 'El cierre remoto está pendiente. Pulsa Finalizar emisión para reintentarlo.');
    if (['starting', 'live'].includes(session.public.status)) return session.public;
    if (!['interrupted', 'failed'].includes(session.public.status)) {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no necesita recuperación.');
    }
    if (session.public.preparationPending) {
      await this.assertSessionMatch(session, authorization);
      return this.finishPreparation(session);
    }
    this.assertCapacity(id);
    const source = this.readiness().sources.find(({ id: sourceId }) => sourceId === session.public.source.id);
    if (source === undefined) {
      throw new PilotServiceError(409, 'NOT_READY', 'La fuente original no está disponible. Conéctala y vuelve a intentar.');
    }
    if (source.kind === 'mobile') {
      await this.mobileCamera?.recoverRuntimeForCourt(session.public.courtSlug);
      if (!this.mobileCamera?.isReadyForCourt(session.public.courtSlug)) {
        throw new PilotServiceError(409, 'NOT_READY', 'La cámara móvil todavía no está lista para recuperar la emisión.');
      }
    }
    if (session.public.mode === 'youtube' && session.ingestUrl === null) {
      throw new PilotServiceError(409, 'NOT_READY', 'No se conservó la entrada protegida de YouTube. Finaliza esta sesión y prepara otra.');
    }
    if (session.public.mode === 'youtube') {
      session.lastYouTubeCheckAt = 0;
      if (!await this.refreshYouTubeHealth(session)) throw new PilotServiceError(503, 'NOT_READY', 'No se pudo comprobar YouTube. Conservamos la sesión; vuelve a intentar la recuperación.');
      if (session.public.status === 'stopped') throw new PilotServiceError(409, 'CONFLICT', 'YouTube ya ha cerrado esta emisión. Prepara una nueva para continuar.');
    }
    await this.assertSessionMatch(session, authorization);
    this.assertCapacity(id);
    if (session.program !== null && session.process !== null) {
      const overlayFailed = session.public.overlayHealth?.status === 'failed';
      const cameraFailed = session.public.continuity?.exhausted === true;
      if (overlayFailed && !this.overlayRenderer?.recover) {
        throw new PilotServiceError(503, 'NOT_READY', 'No se puede recuperar el marcador en este runtime. Finaliza la sesión y comprueba el navegador.');
      }
      session.public = PilotSessionSchema.parse({ ...session.public, status: 'reconnecting', error: null });
      if (overlayFailed) await this.overlayRenderer!.recover!(session.public.courtSlug);
      if (cameraFailed || !overlayFailed) await session.program.recover();
      await this.persistSessions();
      return session.public;
    }
    session.retryAttempt = 0;
    session.diagnostic = '';
    this.spawnSessionProcess(session);
    await this.persistSessions();
    await this.publishStreamLink(session, session.public.watchUrl, authorization);
    return session.public;
  }

  private async sessionOperation(
    id: string, kind: 'start' | 'recover' | 'stop' | 'preflight', operationId: string | undefined,
    action: () => Promise<PilotSession>,
    input: unknown = { id },
  ): Promise<PilotSession> {
    const session = this.get(id);
    const configuration = this.operations.list().find((operation) => operation.kind === 'prepare' && operation.sessionId === id)
      ?? this.configurationByCourt.get(session.public.courtSlug);
    await this.operations.execute(operationId, {
      kind, courtSlug: session.public.courtSlug, sessionId: id,
      matchdayNumber: configuration?.matchdayNumber ?? null,
      seasonLabel: configuration?.seasonLabel ?? null,
    }, input, () => this.changeCourt(session.public.courtSlug, action));
    // A retried request returns current observed state, never a stale 'live' receipt.
    return this.get(id).public;
  }

  private async assertSessionMatch(session: InternalPilotSession, authorization?: string): Promise<void> {
    const configuration = session.configuration ?? this.configurationByCourt.get(session.public.courtSlug);
    if (!configuration || !this.matchBinding) throw new PilotServiceError(409, 'NOT_READY', 'No se conserva la configuración del partido. Finaliza la sesión y guarda la configuración antes de preparar otra.');
    const identity = await this.matchBinding.assertConfigured(configuration, authorization);
    if (identity.homeTeamId !== session.overlay.homeTeamId || identity.awayTeamId !== session.overlay.awayTeamId) {
      throw new PilotServiceError(409, 'CONFLICT', 'El partido del marcador cambió. Conservamos la emisión detenida; revisa los equipos antes de continuar.');
    }
  }

  public isCourtActive(courtSlug: PilotCourtSlug): boolean {
    if (this.changingCourts.has(courtSlug)) return true;
    return [...this.sessions.values()].some((session) =>
      session.public.courtSlug === courtSlug && (this.checkingSessions.has(session.public.id) || session.process !== null || ['starting', 'live', 'reconnecting', 'stopping'].includes(session.public.status)));
  }

  private spawnSessionProcess(session: InternalPilotSession): void {
    if (session.public.mode === 'youtube') this.uploadCheck.cancel();
    if (this.overlayRenderer === undefined) {
      throw new PilotServiceError(503, 'NOT_READY', 'El navegador del overlay no está disponible.');
    }
    const usesMobileCamera = session.public.source.kind === 'mobile';
    const framesPerSecond = usesMobileCamera
      ? this.mobileCamera?.framesPerSecondForCourt(session.public.courtSlug) ?? 30
      : 30;
    const videoEncoding = selectVideoEncoder(this.videoEncoders, framesPerSecond, session.rejectedEncoders);
    const command = pilotProgramCommand(
      this.ffmpegPath,
      session.ingestUrl,
      framesPerSecond,
      videoEncoding,
    );
    const child = spawn(command.executable, command.argv, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: ffmpegEnvironment(),
      shell: false,
      windowsHide: true,
    }) as unknown as PilotChildProcess;
    session.process = child;
    session.overlayController?.abort();
    session.overlayController = new AbortController();
    session.retryTimer = null;
    session.diagnostic = '';
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: 'starting',
      startedAt: session.public.startedAt ?? new Date().toISOString(),
      stoppedAt: null,
      error: null,
      encoder: null,
      videoEncoding,
      signal: null,
      continuity: null,
      overlayHealth: null,
    });
    attachProgress(
      session,
      child,
      (code) => this.handleUnexpectedClose(session, code),
      () => this.queuePersistSessions(),
      new PilotSignalMonitor({ fps: framesPerSecond, remoteOutput: session.ingestUrl !== null,
        audioExpected: usesMobileCamera && (this.mobileCamera?.audioExpectedForCourt(session.public.courtSlug) ?? false) }),
    );
    const overlayInput = child.stdio[3] as Writable;
    void this.overlayRenderer.start(overlayInput, { ...session.overlay, framesPerSecond,
      onState: (overlayHealth) => {
        if (this.shuttingDown || session.process !== child || ['stopping', 'stopped'].includes(session.public.status)) return;
        const wasDegraded = session.public.continuity?.exhausted === true || session.public.overlayHealth?.status === 'failed';
        session.public = PilotSessionSchema.parse({ ...session.public, overlayHealth });
        this.applyComponentHealth(session, wasDegraded);
        this.queuePersistSessions();
      },
    }, session.overlayController.signal).catch(() => {
      if (!this.shuttingDown && session.process === child) child.kill('SIGTERM');
    });
    session.fallbackFrame ??= renderContinuityFrame(courtNameFromSlug(session.public.courtSlug), session.public.title).yuv;
    const program = this.programFactory({ executable: this.ffmpegPath, source: session.public.source,
      mobileRtspUrl: usesMobileCamera ? this.mobileCamera?.rtspUrl(session.public.courtSlug) ?? null : null,
      mobileAudioAvailable: usesMobileCamera && (this.mobileCamera?.audioAvailableForCourt(session.public.courtSlug) ?? false),
      sourceReady: () => !usesMobileCamera || this.mobileCamera?.isReadyForCourt(session.public.courtSlug) === true,
      fps: framesPerSecond, fallback: session.fallbackFrame,
      onProcess: () => this.queuePersistSessions(),
      onState: (continuity) => {
        if (this.shuttingDown || session.process !== child || ['stopping', 'stopped'].includes(session.public.status)) return;
        const wasDegraded = session.public.continuity?.exhausted === true || session.public.overlayHealth?.status === 'failed';
        session.public = PilotSessionSchema.parse({ ...session.public, continuity });
        this.applyComponentHealth(session, wasDegraded);
        this.queuePersistSessions();
      },
    });
    session.program = program;
    const pipes = child.stdio as unknown as readonly Writable[];
    void program.start(pipes[6]!, pipes[7]!).catch(() => {
      if (!this.shuttingDown && session.process === child) child.kill('SIGTERM');
    });
  }

  private applyComponentHealth(session: InternalPilotSession, wasDegraded: boolean): void {
    const error = session.public.continuity?.exhausted ? session.public.continuity.reason ?? 'La cámara necesita recuperación.'
      : session.public.overlayHealth?.status === 'failed' ? session.public.overlayHealth.reason ?? 'El marcador necesita recuperación.' : null;
    if (error) session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed', error });
    else if (wasDegraded && ['failed', 'reconnecting'].includes(session.public.status)) {
      session.public = PilotSessionSchema.parse({ ...session.public,
        status: session.public.mode === 'simulation' && (session.public.encoder?.frame ?? 0) > 0 ? 'live' : 'starting', error: null });
    }
  }

  private handleUnexpectedClose(session: InternalPilotSession, code: number | null): void {
    if (this.shuttingDown) return;
    // EOF, including exit 0, is unexpected until the operator asks to stop.
    if (code === 0) session.diagnostic = 'La fuente terminó antes de que se solicitara el cierre.';
    const encoding = session.public.videoEncoding;
    const gpuFailed = encoding?.hardware && isHardwareEncoderFailure(session.diagnostic);
    if (gpuFailed) session.rejectedEncoders.add(encoderKey(encoding));
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: 'reconnecting',
      error: 'La señal se interrumpió. Reintentando automáticamente.',
      continuity: null,
      signal: null,
      overlayHealth: null,
      ...(gpuFailed ? { encodingWarning: `${encoding.label} falló. Se ha descartado para esta sesión; se utilizará otro codificador disponible o CPU.` } : {}),
    });
    this.queuePersistSessions();
    const program = session.program;
    if (program) {
      void program.close().then(() => {
        if (session.program === program) session.program = null;
        if (!this.shuttingDown) this.scheduleRetry(session);
      }).catch(() => {
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed', error: 'No se pudo cerrar la captura anterior. Finaliza la sesión antes de reintentar.' });
        this.queuePersistSessions();
      });
    } else this.scheduleRetry(session);
  }

  private scheduleRetry(session: InternalPilotSession): void {
    if (session.retryTimer !== null || session.public.status !== 'reconnecting') return;
    if (session.retryAttempt >= MAX_AUTOMATIC_RETRIES) {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: 'failed',
        stoppedAt: new Date().toISOString(),
        error: `${boundedDiagnostic(session.diagnostic)} Recupera la emisión desde Mandos cuando la fuente esté lista. Diagnóstico: ${session.public.id}.`,
      });
      this.queuePersistSessions();
      return;
    }
    const delay = RETRY_DELAYS_MS[session.retryAttempt] ?? RETRY_DELAYS_MS.at(-1) ?? 15_000;
    session.retryAttempt += 1;
    session.retryTimer = setTimeout(() => {
      session.retryTimer = null;
      if (session.public.status !== 'reconnecting') return;
      try {
        this.spawnSessionProcess(session);
      } catch {
        this.scheduleRetry(session);
      }
    }, delay);
    session.retryTimer.unref();
  }

  public async stop(id: string, authorization?: string, operationId?: string): Promise<PilotSession> {
    await this.cancelPreflight(id);
    const preparing = this.preparingSessions.get(id);
    if (preparing) {
      const completed = this.courtCompletions.get(this.get(id).public.courtSlug);
      preparing.controller.abort();
      await Promise.allSettled([preparing.task, completed]);
    }
    return this.sessionOperation(id, 'stop', operationId, () => this.stopSession(id, authorization));
  }

  private async stopSession(id: string, authorization?: string): Promise<PilotSession> {
    const session = this.get(id);
    if (session.public.status === 'stopped') return session.public;
    if (session.public.preparationPending && session.preparation) {
      session.remoteStopPending = true;
      session.public = PilotSessionSchema.parse({ ...session.public, status: 'stopping', error: null });
      await this.persistSessions();
      try {
        const preparation = session.preparation;
        // A failure before the first insert has no remote resources to reconcile.
        // It must remain cancellable even if authorization or connectivity was lost.
        if (preparation.broadcastAttemptAt || preparation.streamAttemptAt || preparation.broadcastId || preparation.streamId) {
          await this.youtube.cancelPreparation(preparation, (state) => this.savePreparation(session, state));
        }
        session.remoteStopPending = false;
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'stopped', preparationPending: false,
          stoppedAt: new Date().toISOString(), error: null,
        });
        await this.persistSessions();
        await this.operations.reconcileSessions([session]);
        return session.public;
      } catch (error) {
        const failure = mapYouTubeError(error);
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed', error: `${failure.message} El cierre sigue pendiente; vuelve a Finalizar sesión.` });
        await this.persistSessions();
        throw failure;
      }
    }
    if (!['prepared', 'starting', 'live', 'reconnecting', 'interrupted', 'failed'].includes(session.public.status)) {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no está preparada ni emitiendo.');
    }
    const wasPrepared = session.public.status === 'prepared';
    session.remoteStopPending = session.public.mode === 'youtube' && session.public.broadcastId !== null;
    session.public = PilotSessionSchema.parse({ ...session.public, status: 'stopping' });
    await this.persistSessions();
    if (wasPrepared && session.public.broadcastId !== null) {
      try { await this.youtube.cancelBroadcast(session.public.broadcastId); }
      catch (error) {
        session.remoteStopPending = false;
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'prepared' });
        await this.persistSessions();
        throw mapYouTubeError(error);
      }
      session.remoteStopPending = false;
    }
    if (session.retryTimer !== null) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    const child = session.process;
    session.overlayController?.abort();
    session.overlayController = null;
    child?.kill('SIGTERM');
    if (session.program) {
      try { await session.program.close(); session.program = null; }
      catch {
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed', error: 'La salida se ha detenido, pero no se pudo cerrar la captura. Vuelve a Finalizar sesión.' });
        await this.persistSessions();
        throw new PilotServiceError(503, 'NOT_READY', session.public.error!);
      }
    }
    if (child !== null) {
      const forceStop = setTimeout(() => {
        if (session.process === child) child.kill('SIGKILL');
      }, 3_000);
      forceStop.unref();
    }
    let remoteError = false;
    if (!wasPrepared && session.public.mode === 'youtube' && session.public.broadcastId !== null) {
      try {
        await this.youtube.completeBroadcast(session.public.broadcastId);
        session.remoteStopPending = false;
      } catch {
        remoteError = true;
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed',
          error: 'El encoder se ha detenido, pero YouTube no ha confirmado el cierre. Pulsa Finalizar emisión para reintentarlo.',
        });
      }
    }
    if (!remoteError && session.process === null) {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
      });
    }
    if (!remoteError) {
      await rm(join(`${this.configurationPath}.previews`, id), { recursive: true, force: true });
      this.checkedContexts.delete(id);
      if (session.public.preflight) session.public = { ...session.public, preflight: { ...session.public.preflight, preview: null } };
    }
    await this.persistSessions();
    await this.publishStreamLink(session, null, authorization);
    return session.public;
  }

  /**
   * The public home links to the broadcast, so the link follows the emission lifecycle.
   * A rejected publication never stops the emission: the stream matters more than the link.
   */
  private async publishStreamLink(
    session: InternalPilotSession,
    watchUrl: string | null,
    authorization?: string,
  ): Promise<void> {
    if (this.streamLink === undefined || session.public.mode !== 'youtube') return;
    try {
      await this.streamLink.publish(session.public.courtSlug, watchUrl, authorization);
    } catch {
      session.diagnostic = `${session.diagnostic}\nNo se pudo publicar el enlace de YouTube en la web pública.`
        .slice(-MAX_DIAGNOSTIC_LENGTH);
    }
  }

  public previewThumbnail(rawInput: unknown): Uint8Array {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos de la portada.');
    return productionAssets(parsed.data).pngBytes;
  }

  public thumbnail(id: string): Uint8Array {
    return this.get(id).thumbnail;
  }

  public shutdown(): Promise<void> {
    this.shutdownTask ??= this.closeRuntime();
    return this.shutdownTask;
  }

  private async closeRuntime(): Promise<void> {
    this.shuttingDown = true;
    this.uploadCheck.cancel();
    this.stopMobileObserver?.();
    this.stopMobileObserver = null;
    for (const session of this.sessions.values()) {
      if (session.retryTimer !== null) clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    for (const preparing of this.preparingSessions.values()) preparing.controller.abort();
    for (const checking of this.checkingSessions.values()) checking.controller.abort();
    await Promise.allSettled([...this.checkingSessions.values()].map(({ task }) => task));
    await Promise.allSettled([...this.preparingSessions.values()].map(({ task }) => task));
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    const captures = await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      if (session.program) { await session.program.close(); session.program = null; }
    }));
    let outputs: PromiseSettledResult<void>[] = [];
    try { await this.persistSessions(); }
    finally {
      outputs = await Promise.allSettled([...this.sessions.values()].map(async (session) => {
        session.overlayController?.abort();
        if (session.process) await closeOutputProcess(session.process);
      }));
      await this.overlayRenderer?.close();
    }
    if ([...captures, ...outputs].some(({ status }) => status === 'rejected')) {
      throw new PilotServiceError(503, 'RUNTIME_ERROR', 'No se pudieron cerrar todos los procesos de emisión. Se conserva su identidad para el siguiente arranque.');
    }
  }

  private assertCapacity(excludedSessionId?: string): void {
    const active = [...this.sessions.entries()].filter(([id, session]) =>
      id !== excludedSessionId && (this.checkingSessions.has(id) || session.process !== null || ['starting', 'live', 'reconnecting', 'stopping'].includes(session.public.status))).length;
    if (active >= MAX_ACTIVE_SESSIONS) throw new PilotServiceError(409, 'CONFLICT', 'Ya hay tres salidas activas.');
  }

  private async loadSessions(): Promise<void> {
    try {
      const parsed = PersistedPilotSessionsSchema.parse(JSON.parse(await readFile(this.sessionPath(), 'utf8')));
      for (const saved of parsed.sessions) {
        if (saved.previewCapture) await stopOrphanedEncoder(saved.previewCapture);
        if (saved.previewEncoder) await stopOrphanedEncoder(saved.previewEncoder);
        if (saved.captureProcess) await stopOrphanedEncoder(saved.captureProcess);
        const orphanStopped = saved.runtimeProcess ? await stopOrphanedEncoder(saved.runtimeProcess) : false;
        const wasActive = ['preparing', 'starting', 'live', 'reconnecting', 'stopping'].includes(saved.public.status)
          || (saved.public.status === 'failed' && (saved.public.continuity?.active === true || saved.public.overlayHealth?.status === 'failed'));
        const publicSession = PilotSessionSchema.parse(wasActive || orphanStopped ? {
          ...saved.public,
          status: 'interrupted',
          encoder: null,
          signal: null,
          continuity: null,
          overlayHealth: null,
          error: orphanStopped
            ? 'El servicio se reinició y se ha detenido un encoder huérfano. Comprueba la fuente y recupera esta misma emisión.'
            : 'El servicio se reinició durante esta emisión. Comprueba la fuente y pulsa Recuperar emisión.',
        } : saved.public);
        if (publicSession.preflight) publicSession.preflight = { ...publicSession.preflight, status: 'stale', validUntil: null };
        this.sessions.set(publicSession.id, {
          public: publicSession,
          thumbnail: Buffer.from(saved.thumbnailBase64, 'base64'),
          streamId: saved.streamId,
          ingestUrl: saved.ingestUrl,
          process: null,
          retryTimer: null,
          retryAttempt: 0,
          diagnostic: '',
          lastYouTubeCheckAt: 0,
          overlay: {
            courtSlug: saved.overlay.courtSlug,
            ...(saved.overlay.homeTeamId === undefined ? {} : { homeTeamId: saved.overlay.homeTeamId }),
            ...(saved.overlay.awayTeamId === undefined ? {} : { awayTeamId: saved.overlay.awayTeamId }),
          },
          overlayController: null,
          rejectedEncoders: new Set(saved.rejectedEncoders ?? []),
          remoteStopPending: saved.remoteStopPending ?? false,
          configuration: saved.configuration ?? this.configurationByCourt.get(publicSession.courtSlug),
          preparationOperationId: saved.preparationOperationId,
          preparation: saved.preparation,
          program: null,
          fallbackFrame: null,
        });
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo recuperar el estado guardado de las emisiones.');
    }
  }

  private sessionPath(): string {
    return `${this.configurationPath}.sessions`;
  }

  private queuePersistSessions(): void {
    const states = [...this.sessions.values()].map((session) => ({
      public: session.public, configuration: session.configuration,
      observed: { operationId: this.operations.correlationId(session.public), createdAt: new Date().toISOString() },
    }));
    this.persistQueue = this.persistQueue.then(() => this.writeSessions(states), () => this.writeSessions(states));
    void this.persistQueue.catch(() => {
      this.persistenceError = 'No se pudo guardar el estado o el historial. La señal puede continuar; revisa el almacenamiento antes de reiniciar el servicio.';
    });
  }

  private async persistSessions(): Promise<void> {
    this.queuePersistSessions();
    await this.persistQueue;
  }

  private async writeSessions(states: readonly (Pick<InternalPilotSession, 'public' | 'configuration'> & {
    observed: { operationId: string | null; createdAt: string };
  })[]): Promise<void> {
    while (this.pendingMobileIncidents[0]) {
      const incident = this.pendingMobileIncidents[0];
      await this.operations.recordMobileRuntime(incident.event, incident.context);
      this.pendingMobileIncidents.shift();
    }
    for (const session of states) {
      await this.operations.recordState(session.public, session.configuration?.matchdayNumber ?? null, session.configuration?.seasonLabel ?? null, session.observed);
      await this.operations.recordSignal(session.public, session.configuration?.matchdayNumber ?? null, session.configuration?.seasonLabel ?? null, session.observed);
      await this.operations.recordContinuity(session.public, session.configuration?.matchdayNumber ?? null, session.configuration?.seasonLabel ?? null, session.observed);
      await this.operations.recordOverlay(session.public, session.configuration?.matchdayNumber ?? null, session.configuration?.seasonLabel ?? null, session.observed);
    }
    const path = this.sessionPath();
    const payload = PersistedPilotSessionsSchema.parse({
      version: 1,
      sessions: [...this.sessions.values()].map((session) => ({
        public: session.public,
        thumbnailBase64: Buffer.from(session.thumbnail).toString('base64'),
        streamId: session.streamId,
        ingestUrl: session.ingestUrl,
        source: session.public.source,
        rejectedEncoders: [...session.rejectedEncoders],
        remoteStopPending: session.remoteStopPending,
        runtimeProcess: encoderProcessIdentity(session.process?.pid),
        captureProcess: encoderProcessIdentity(session.program?.captureProcess?.pid),
        previewEncoder: encoderProcessIdentity(this.previewProcesses.get(session.public.id)?.encoder),
        previewCapture: encoderProcessIdentity(this.previewProcesses.get(session.public.id)?.capture),
        configuration: session.configuration,
        preparationOperationId: session.preparationOperationId,
        preparation: session.preparation,
        overlay: session.overlay,
      })),
    });
    try {
      await writePrivateJson(path, payload);
      this.persistenceError = null;
    } catch {
      throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo guardar el estado recuperable de las emisiones.');
    }
  }

  private async refreshYouTubeHealth(session: InternalPilotSession): Promise<boolean> {
    if (session.public.preparationPending) return true;
    if (session.public.mode !== 'youtube' || session.public.broadcastId === null || session.streamId === null) return true;
    if (Date.now() - session.lastYouTubeCheckAt < 5_000) return true;
    session.lastYouTubeCheckAt = Date.now();
    try {
      const health = await this.youtube.health(session.public.broadcastId, session.streamId);
      const previous = session.public.status;
      session.public = observeYouTubeSession(session.public, health, session.process !== null);
      if (health.broadcastStatus === 'complete' || health.broadcastStatus === 'revoked') {
        session.remoteStopPending = false;
        if (session.process !== null) {
          // Stop a useless encoder without scheduling a new connection to a closed broadcast.
          session.public = PilotSessionSchema.parse({ ...session.public, status: 'stopping' });
          session.process.kill('SIGTERM');
        }
      }
      if (previous !== session.public.status) this.queuePersistSessions();
      return health.broadcastStatus !== null;
    } catch {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        youtubeStreamStatus: 'Sin respuesta de YouTube',
      });
      return false;
    }
  }

  private async loadConfigurations(): Promise<void> {
    try {
      const parsed = PilotConfigurationsSchema.parse(JSON.parse(await readFile(this.configurationPath, 'utf8')));
      for (const configuration of parsed) this.configurationByCourt.set(configuration.courtSlug, configuration);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo leer la configuración guardada de las pistas.');
    }
  }

  private async persistConfigurations(): Promise<void> {
    try { await writePrivateJson(this.configurationPath, this.configurations()); }
    catch { throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo guardar la configuración de las pistas.'); }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function discoverSources(): readonly PilotSource[] {
  const sources: PilotSource[] = [{ id: 'synthetic', kind: 'synthetic', label: 'Señal de prueba 1080p30' }];
  let entries: string[] = [];
  try {
    entries = readdirSync('/dev').filter((entry) => /^video\d+$/.test(entry)).sort();
  } catch {
    return sources;
  }
  for (const entry of entries) {
    const devicePath = `/dev/${entry}`;
    sources.push({ id: `v4l2:${devicePath}`, kind: 'v4l2', label: `Cámara ${devicePath}`, devicePath });
  }
  return sources;
}

function productionAssets(input: PreparePilotSessionInput) {
  return createProductionAssets({
    leagueName: 'Kings Padel League',
    seasonLabel: input.seasonLabel,
    matchdayLabel: 'Jornada',
    matchdayNumber: input.matchdayNumber,
    courtName: courtNameFromSlug(input.courtSlug),
    home: { name: input.homeTeam },
    away: { name: input.awayTeam },
    scheduledAt: input.scheduledAt,
    timeZone: 'Europe/Madrid',
    locale: 'es-ES',
    publicUrl: `https://live.kingspadelleague.es/live/${input.courtSlug}`,
    templateRevision: 'kpl-season-v2',
  });
}

function courtNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part, index) => index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}


function attachProgress(
  session: InternalPilotSession,
  child: PilotChildProcess,
  onUnexpectedClose: (code: number | null) => void,
  onStatusChange: () => void,
  signal: PilotSignalMonitor,
): void {
  const publishSignal = () => {
    const measured = signal.snapshot();
    const snapshot = session.public.continuity?.active ? { ...measured,
      issues: measured.issues.filter(({ code }) => !['black_video', 'frozen_video', 'silent_audio'].includes(code)),
    } : measured;
    const previous = session.public.signal;
    session.public = { ...session.public, signal: snapshot };
    if (previous?.checking !== snapshot.checking || JSON.stringify(previous?.issues.map(({ code }) => code)) !== JSON.stringify(snapshot.issues.map(({ code }) => code))) onStatusChange();
  };
  let progress: Record<string, string> = {};
  let pending = '';
  let lastFrame = 0;
  let lastAdvanceAt = Date.now();
  let healthySince: number | null = null;
  let forcedStop: NodeJS.Timeout | null = null;
  const watchdog = setInterval(() => {
    if (session.process !== child || ['stopping', 'stopped'].includes(session.public.status)
      || (session.public.status === 'failed' && !session.public.continuity?.active && session.public.overlayHealth?.status !== 'failed')) return;
    if (session.public.overlayHealth?.lastFrameAt === null) { lastAdvanceAt = Date.now(); return; }
    publishSignal();
    if (Date.now() - lastAdvanceAt < 20_000 || forcedStop !== null) return;
    session.diagnostic = 'El encoder lleva 20 segundos sin producir nuevos fotogramas. Revisa la fuente, el overlay y la conexión.';
    child.kill('SIGTERM');
    forcedStop = setTimeout(() => { if (session.process === child) child.kill('SIGKILL'); }, 2_000);
    forcedStop.unref();
  }, 1_000);
  watchdog.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (session.process !== child) return;
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      progress[line.slice(0, separator)] = line.slice(separator + 1);
      if (line === 'progress=continue' || line === 'progress=end') {
        signal.progress(progress);
        const encoder = encoderHealth(progress);
        if (encoder.frame > lastFrame) {
          lastAdvanceAt = Date.now();
          healthySince ??= lastAdvanceAt;
          if (lastAdvanceAt - healthySince >= 30_000) session.retryAttempt = 0;
          lastFrame = encoder.frame;
        }
        const previousStatus = session.public.status;
        const status = session.public.status === 'starting'
          && session.public.mode === 'simulation'
          && encoder.frame > 0
          ? 'live'
          : session.public.status;
        session.public = PilotSessionSchema.parse({
          ...session.public,
          status,
          error: ['starting', 'live'].includes(status) ? null : session.public.error,
          encoder,
        });
        if (status !== previousStatus) onStatusChange();
        publishSignal();
        progress = {};
      }
    }
  });
  const signalPipes = child.stdio as unknown as readonly (Readable | Writable | null)[];
  for (const [index, receive] of [[4, (chunk: string) => signal.video(chunk)], [5, (chunk: string) => signal.audio(chunk)]] as const) {
    const pipe = signalPipes[index] as Readable | null | undefined;
    pipe?.setEncoding('utf8');
    pipe?.on('data', (chunk: string) => { if (session.process === child) { receive(chunk); publishSignal(); } });
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    session.diagnostic = `${session.diagnostic}${chunk}`.slice(-MAX_DIAGNOSTIC_LENGTH);
  });
  child.once('error', () => { session.diagnostic = `${session.diagnostic}\nNo se pudo iniciar FFmpeg.`; });
  child.once('close', (code) => {
    clearInterval(watchdog);
    if (forcedStop !== null) clearTimeout(forcedStop);
    if (session.process !== child) return;
    const requested = ['stopping', 'stopped'].includes(session.public.status) || session.remoteStopPending;
    session.process = null;
    session.overlayController?.abort();
    session.overlayController = null;
    if (requested) {
      const program = session.program;
      if (program) void program.close().then(() => {
        if (session.program === program) session.program = null;
        onStatusChange();
      }).catch(() => {
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'failed', error: 'No se pudo cerrar la captura anterior. Vuelve a Finalizar sesión.' });
        onStatusChange();
      });
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: session.remoteStopPending ? session.public.status : 'stopped',
        stoppedAt: session.remoteStopPending ? session.public.stoppedAt : new Date().toISOString(),
        error: session.remoteStopPending ? session.public.error : null,
      });
      onStatusChange();
      return;
    }
    onUnexpectedClose(code);
  });
}

function closeOutputProcess(child: PilotChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let forced: NodeJS.Timeout | undefined;
    const finished = () => { clearTimeout(timer); clearTimeout(forced); resolve(); };
    const timer = setTimeout(() => {
      forced = setTimeout(() => { child.off('close', finished); reject(new Error('Encoder did not close')); }, 2_000);
      forced.unref();
      child.kill('SIGKILL');
    }, 2_000);
    timer.unref();
    child.once('close', finished);
    child.kill('SIGTERM');
  });
}

function encoderHealth(progress: Readonly<Record<string, string>>): PilotEncoderHealth {
  return {
    frame: numeric(progress.frame),
    framesPerSecond: numeric(progress.fps),
    bitrateKbps: numeric(progress.bitrate?.replace('kbits/s', '')),
    speed: numeric(progress.speed?.replace('x', '')),
  };
}

function numeric(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedDiagnostic(value: string): string {
  // FFmpeg may print only a suffix of an ingest URL, so replacing the full URL is insufficient.
  if (/permission denied|operation not permitted/i.test(value)) return 'FFmpeg no tiene permiso para acceder a la fuente o al encoder.';
  if (/connection refused|connection reset|broken pipe/i.test(value)) return 'Se perdió la conexión con la fuente o el destino.';
  if (/timed out|sin producir nuevos fotogramas/i.test(value)) return 'La fuente, el overlay o el destino dejó de responder.';
  if (/no such file|cannot open|device.*busy/i.test(value)) return 'La fuente no está disponible o está ocupada.';
  if (isHardwareEncoderFailure(value)) return 'El codificador de vídeo no pudo continuar.';
  return 'FFmpeg terminó inesperadamente. Revisa la fuente y el destino.';
}

function mapYouTubeError(error: unknown): PilotServiceError {
  if (error instanceof PilotYouTubeError) {
    const status = error.code === 'NOT_AUTHORIZED' || error.code === 'NOT_CONFIGURED' ? 409 : 502;
    return new PilotServiceError(status, 'NOT_READY', error.message);
  }
  return new PilotServiceError(502, 'RUNTIME_ERROR', 'YouTube no pudo preparar el directo.');
}
