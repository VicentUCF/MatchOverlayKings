import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createProductionAssets } from '@kpl/production-assets';
import {
  PilotSourceSchema,
  PilotReadinessSchema,
  PilotConfigurationSchema,
  PilotConfigurationsSchema,
  PilotSessionSchema,
  PreparePilotSessionInputSchema,
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
import type { PilotMatchBinding } from './pilot-match-binding.js';
import { PilotYouTubeError } from './pilot-youtube.js';
import type { PilotYouTubeGateway } from './pilot-youtube.js';
import type { PilotMobileCameraService } from './pilot-mobile-camera.js';
import type { PilotOverlayOptions, PilotOverlayRenderer } from './pilot-overlay.js';
import {
  CPU_ENCODER, detectVideoEncoders, encoderFilter, encoderInputArguments, encoderKey,
  encoderOutputArguments, ffmpegEnvironment, isHardwareEncoderFailure, selectVideoEncoder,
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
  readonly streamId: string | null;
  readonly ingestUrl: string | null;
  process: PilotChildProcess | null;
  retryTimer: NodeJS.Timeout | null;
  retryAttempt: number;
  diagnostic: string;
  lastYouTubeCheckAt: number;
  readonly overlay: Omit<PilotOverlayOptions, 'framesPerSecond'>;
  overlayController: AbortController | null;
  readonly rejectedEncoders: Set<string>;
};

type PilotChildProcess = ChildProcessByStdio<null, Readable, Readable>;

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
  private ffmpegVersion: string | null = null;
  private videoEncoders: readonly PilotVideoEncoder[] = [CPU_ENCODER];
  private persistQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  public constructor(
    private readonly ffmpegPath: string,
    private readonly youtube: PilotYouTubeGateway,
    private readonly configurationPath: string,
    private readonly mobileCamera?: PilotMobileCameraService,
    private readonly overlayRenderer?: PilotOverlayRenderer,
    private readonly matchBinding?: PilotMatchBinding,
  ) {}

  public async initialize(): Promise<void> {
    await this.youtube.initialize();
    await this.loadConfigurations();
    await this.loadSessions();
    const probe = spawnSync(this.ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 5_000 });
    this.ffmpegVersion = probe.status === 0
      ? probe.stdout.split(/\r?\n/, 1)[0]?.trim() || null
      : null;
    if (this.ffmpegVersion !== null) this.videoEncoders = await detectVideoEncoders(this.ffmpegPath);
    await this.persistSessions();
  }

  public configurations(): readonly PilotConfiguration[] {
    return PilotConfigurationsSchema.parse([...this.configurationByCourt.values()]);
  }

  public async configure(rawCourtSlug: unknown, rawInput: unknown, authorization?: string): Promise<PilotConfiguration> {
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
    return this.changeCourt(configuration.courtSlug, async () => {
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
    });
  }

  public readiness(): PilotReadiness {
    const mobileSource = this.mobileCamera?.source() ?? null;
    const sources = [...discoverSources(), ...(mobileSource === null ? [] : [mobileSource])];
    const limitations: string[] = [];
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
    try { return await operation(); } finally { this.changingCourts.delete(courtSlug); }
  }

  public async prepare(rawInput: unknown, authorization?: string): Promise<PilotSession> {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos del directo.');
    return this.changeCourt(parsed.data.courtSlug, () => this.prepareCourt(parsed.data, authorization));
  }

  private async prepareCourt(rawInput: unknown, authorization?: string): Promise<PilotSession> {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos del directo.');
    const input = parsed.data;
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
    if (source.kind !== 'synthetic') {
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
    let youtubePrepared: Awaited<ReturnType<PilotYouTubeGateway['prepareBroadcast']>> | null = null;
    if (input.mode === 'youtube') {
      try {
        youtubePrepared = await this.youtube.prepareBroadcast({
          title: assets.title,
          description: assets.description,
          scheduledAt: input.scheduledAt,
          privacyStatus: input.privacyStatus,
          thumbnail: assets.pngBytes,
          framesPerSecond: source.kind === 'mobile'
            ? this.mobileCamera?.framesPerSecondForCourt(input.courtSlug) ?? 30
            : 30,
        });
      } catch (error) {
        throw mapYouTubeError(error);
      }
    }

    const id = randomUUID();
    const session = PilotSessionSchema.parse({
      id,
      courtSlug: input.courtSlug,
      mode: input.mode,
      source,
      status: 'prepared',
      title: assets.title,
      description: assets.description,
      thumbnailUrl: `/api/pilot/sessions/${id}/thumbnail`,
      broadcastId: youtubePrepared?.broadcastId ?? null,
      watchUrl: youtubePrepared?.watchUrl ?? null,
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
      streamId: youtubePrepared?.streamId ?? null,
      ingestUrl: youtubePrepared?.ingestUrl ?? null,
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
    });
    try {
      await this.persistSessions();
    } catch (error) {
      this.sessions.delete(id);
      if (youtubePrepared !== null) {
        try { await this.youtube.cancelBroadcast(youtubePrepared.broadcastId); } catch { /* Preserve the storage failure. */ }
      }
      throw error;
    }
    return session;
  }

  public async list(): Promise<readonly PilotSession[]> {
    await Promise.all([...this.sessions.values()].map((session) => this.refreshYouTubeHealth(session)));
    return [...this.sessions.values()].map(({ public: session }) => session);
  }

  public get(id: string): InternalPilotSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe esa sesión de emisión.');
    return session;
  }

  public async start(id: string): Promise<PilotSession> {
    const session = this.get(id);
    if (session.public.status !== 'prepared') {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no está preparada para emitir.');
    }
    const active = [...this.sessions.values()].filter(({ public: current }) =>
      ['starting', 'live', 'reconnecting', 'stopping'].includes(current.status)).length;
    if (active >= MAX_ACTIVE_SESSIONS) throw new PilotServiceError(409, 'CONFLICT', 'Ya hay tres salidas activas.');
    if (session.public.mode === 'youtube' && session.ingestUrl === null) {
      throw new PilotServiceError(409, 'NOT_READY', 'La entrada de YouTube no está preparada.');
    }

    this.spawnSessionProcess(session);
    await this.persistSessions();
    return session.public;
  }

  public async recover(id: string): Promise<PilotSession> {
    const session = this.get(id);
    if (!['interrupted', 'failed'].includes(session.public.status)) {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no necesita recuperación.');
    }
    this.assertCapacity(id);
    const source = this.readiness().sources.find(({ id: sourceId }) => sourceId === session.public.source.id);
    if (source === undefined) {
      throw new PilotServiceError(409, 'NOT_READY', 'La fuente original no está disponible. Conéctala y vuelve a intentar.');
    }
    if (source.kind === 'mobile' && !this.mobileCamera?.isReadyForCourt(session.public.courtSlug)) {
      throw new PilotServiceError(409, 'NOT_READY', 'La cámara móvil todavía no está lista para recuperar la emisión.');
    }
    if (session.public.mode === 'youtube' && session.ingestUrl === null) {
      throw new PilotServiceError(409, 'NOT_READY', 'No se conservó la entrada protegida de YouTube. Finaliza esta sesión y prepara otra.');
    }
    session.retryAttempt = 0;
    session.diagnostic = '';
    this.spawnSessionProcess(session);
    await this.persistSessions();
    return session.public;
  }

  public isCourtActive(courtSlug: PilotCourtSlug): boolean {
    return [...this.sessions.values()].some(({ public: session }) =>
      session.courtSlug === courtSlug && ['starting', 'live', 'reconnecting', 'stopping'].includes(session.status));
  }

  private spawnSessionProcess(session: InternalPilotSession): void {
    if (this.overlayRenderer === undefined) {
      throw new PilotServiceError(503, 'NOT_READY', 'El navegador del overlay no está disponible.');
    }
    const usesMobileCamera = session.public.source.kind === 'mobile';
    const framesPerSecond = usesMobileCamera
      ? this.mobileCamera?.framesPerSecondForCourt(session.public.courtSlug) ?? 30
      : 30;
    const videoEncoding = selectVideoEncoder(this.videoEncoders, framesPerSecond, session.rejectedEncoders);
    const command = ffmpegCommand(
      this.ffmpegPath,
      session.public.source,
      session.ingestUrl,
      usesMobileCamera ? this.mobileCamera?.rtspUrl() ?? null : null,
      usesMobileCamera ? this.mobileCamera?.audioAvailableForCourt(session.public.courtSlug) ?? false : false,
      framesPerSecond,
      videoEncoding,
    );
    const child = spawn(command.executable, command.argv, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: ffmpegEnvironment(),
      shell: false,
      windowsHide: true,
    }) as unknown as PilotChildProcess;
    session.process = child;
    session.overlayController?.abort();
    session.overlayController = new AbortController();
    const overlayInput = child.stdio[3] as Writable;
    void this.overlayRenderer.start(
      overlayInput,
      { ...session.overlay, framesPerSecond },
      session.overlayController.signal,
    ).catch(() => {
      if (session.process === child) child.kill('SIGTERM');
    });
    session.retryTimer = null;
    session.diagnostic = '';
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: 'starting',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      error: null,
      encoder: null,
      videoEncoding,
    });
    attachProgress(
      session,
      child,
      (code) => this.handleUnexpectedClose(session, code),
      () => this.queuePersistSessions(),
    );
  }

  private handleUnexpectedClose(session: InternalPilotSession, code: number | null): void {
    if (this.shuttingDown) return;
    if (code === 0) {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
        error: null,
      });
      this.queuePersistSessions();
      return;
    }
    const encoding = session.public.videoEncoding;
    const gpuFailed = encoding?.hardware && isHardwareEncoderFailure(session.diagnostic);
    if (gpuFailed) session.rejectedEncoders.add(encoderKey(encoding));
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: 'reconnecting',
      error: 'La señal se interrumpió. Reintentando automáticamente.',
      ...(gpuFailed ? { encodingWarning: `${encoding.label} falló. Se ha descartado para esta sesión; se utilizará otro codificador disponible o CPU.` } : {}),
    });
    this.queuePersistSessions();
    this.scheduleRetry(session);
  }

  private scheduleRetry(session: InternalPilotSession): void {
    if (session.retryTimer !== null || session.public.status !== 'reconnecting') return;
    if (session.retryAttempt >= MAX_AUTOMATIC_RETRIES) {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: 'failed',
        stoppedAt: new Date().toISOString(),
        error: `${boundedDiagnostic(session.diagnostic, session.ingestUrl)} Recupera la emisión desde Mandos cuando la fuente esté lista.`,
      });
      this.queuePersistSessions();
      return;
    }
    const delay = RETRY_DELAYS_MS[session.retryAttempt] ?? RETRY_DELAYS_MS.at(-1) ?? 15_000;
    session.retryAttempt += 1;
    session.retryTimer = setTimeout(() => {
      session.retryTimer = null;
      if (session.public.status !== 'reconnecting') return;
      const sourceAvailable = this.readiness().sources.some(({ id }) => id === session.public.source.id);
      const mobileReady = session.public.source.kind !== 'mobile'
        || this.mobileCamera?.isReadyForCourt(session.public.courtSlug) === true;
      if (!sourceAvailable || !mobileReady) {
        this.scheduleRetry(session);
        return;
      }
      try {
        this.spawnSessionProcess(session);
      } catch {
        this.scheduleRetry(session);
      }
    }, delay);
    session.retryTimer.unref();
  }

  public async stop(id: string): Promise<PilotSession> {
    const session = this.get(id);
    if (!['prepared', 'starting', 'live', 'reconnecting', 'interrupted', 'failed'].includes(session.public.status)) {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no está preparada ni emitiendo.');
    }
    const wasPrepared = session.public.status === 'prepared';
    session.public = PilotSessionSchema.parse({ ...session.public, status: 'stopping' });
    await this.persistSessions();
    if (wasPrepared && session.public.broadcastId !== null) {
      try { await this.youtube.cancelBroadcast(session.public.broadcastId); }
      catch (error) {
        session.public = PilotSessionSchema.parse({ ...session.public, status: 'prepared' });
        await this.persistSessions();
        throw mapYouTubeError(error);
      }
    }
    if (session.retryTimer !== null) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    const child = session.process;
    session.overlayController?.abort();
    session.overlayController = null;
    child?.kill('SIGTERM');
    if (child !== null) {
      const forceStop = setTimeout(() => {
        if (session.process === child) child.kill('SIGKILL');
      }, 3_000);
      forceStop.unref();
    }
    if (!wasPrepared && session.public.mode === 'youtube' && session.public.broadcastId !== null) {
      try {
        await this.youtube.completeBroadcast(session.public.broadcastId);
      } catch {
        // The encoder is still stopped locally; the next status refresh exposes the remote discrepancy.
      }
    }
    if (child === null) {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
      });
      await this.persistSessions();
    }
    return session.public;
  }

  public previewThumbnail(rawInput: unknown): Uint8Array {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos de la portada.');
    return productionAssets(parsed.data).pngBytes;
  }

  public thumbnail(id: string): Uint8Array {
    return this.get(id).thumbnail;
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.persistSessions();
    for (const session of this.sessions.values()) {
      if (session.retryTimer !== null) clearTimeout(session.retryTimer);
      session.overlayController?.abort();
      session.process?.kill('SIGTERM');
    }
    await this.overlayRenderer?.close();
  }

  private assertCapacity(excludedSessionId?: string): void {
    const active = [...this.sessions.entries()].filter(([id, { public: current }]) =>
      id !== excludedSessionId && ['starting', 'live', 'reconnecting', 'stopping'].includes(current.status)).length;
    if (active >= MAX_ACTIVE_SESSIONS) throw new PilotServiceError(409, 'CONFLICT', 'Ya hay tres salidas activas.');
  }

  private async loadSessions(): Promise<void> {
    try {
      const parsed = PersistedPilotSessionsSchema.parse(JSON.parse(await readFile(this.sessionPath(), 'utf8')));
      for (const saved of parsed.sessions) {
        const wasActive = ['starting', 'live', 'reconnecting', 'stopping'].includes(saved.public.status);
        const publicSession = PilotSessionSchema.parse(wasActive ? {
          ...saved.public,
          status: 'interrupted',
          encoder: null,
          error: 'El servicio se reinició durante esta emisión. Comprueba la fuente y pulsa Recuperar emisión.',
        } : saved.public);
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
    this.persistQueue = this.persistQueue.then(() => this.writeSessions(), () => this.writeSessions());
    void this.persistQueue.catch(() => undefined);
  }

  private async persistSessions(): Promise<void> {
    this.queuePersistSessions();
    await this.persistQueue;
  }

  private async writeSessions(): Promise<void> {
    const path = this.sessionPath();
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const payload = PersistedPilotSessionsSchema.parse({
      version: 1,
      sessions: [...this.sessions.values()].map((session) => ({
        public: session.public,
        thumbnailBase64: Buffer.from(session.thumbnail).toString('base64'),
        streamId: session.streamId,
        ingestUrl: session.ingestUrl,
        source: session.public.source,
        rejectedEncoders: [...session.rejectedEncoders],
        overlay: session.overlay,
      })),
    });
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await rename(temporaryPath, path);
    } catch {
      throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo guardar el estado recuperable de las emisiones.');
    }
  }

  private async refreshYouTubeHealth(session: InternalPilotSession): Promise<void> {
    if (session.public.mode !== 'youtube' || session.public.broadcastId === null || session.streamId === null) return;
    if (Date.now() - session.lastYouTubeCheckAt < 5_000) return;
    session.lastYouTubeCheckAt = Date.now();
    try {
      const health = await this.youtube.health(session.public.broadcastId, session.streamId);
      const isLive = health.broadcastStatus === 'live' || health.streamStatus === 'active';
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: isLive && session.process !== null ? 'live' : session.public.status,
        youtubeStreamStatus: [health.streamStatus, health.healthStatus].filter(Boolean).join(' · ') || null,
      });
    } catch {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        youtubeStreamStatus: 'Sin respuesta de YouTube',
      });
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
    const directory = dirname(this.configurationPath);
    const temporaryPath = `${this.configurationPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(this.configurations(), null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.configurationPath);
    } catch {
      throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo guardar la configuración de las pistas.');
    }
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

function ffmpegCommand(
  executable: string,
  source: PilotSource,
  ingestUrl: string | null,
  mobileRtspUrl: string | null,
  mobileAudioAvailable: boolean,
  outputFramesPerSecond: 30 | 60,
  videoEncoding: PilotVideoEncoder,
) {
  const input = source.kind === 'synthetic'
    ? ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    : source.kind === 'v4l2'
      ? ['-thread_queue_size', '512', '-f', 'v4l2', '-framerate', '30', '-video_size', '1920x1080', '-i', source.devicePath,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
      : mobileRtspUrl === null
        ? (() => { throw new PilotServiceError(503, 'NOT_READY', 'La entrada RTSP móvil no está disponible.'); })()
        : [
          '-rtsp_transport', 'tcp', '-thread_queue_size', '512', '-i', mobileRtspUrl,
          ...(mobileAudioAvailable ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
        ];
  const audioInput = source.kind === 'mobile' && mobileAudioAvailable ? '0:a:0' : '1:a:0';
  const overlayInputIndex = source.kind === 'mobile' && mobileAudioAvailable ? 1 : 2;
  const baseVideo = source.kind === 'mobile'
    ? `[0:v]scale=1920:1080:flags=lanczos[base];[base][${overlayInputIndex}:v]overlay=0:0:format=auto[composite]`
    : `[0:v][${overlayInputIndex}:v]overlay=0:0:format=auto[composite]`;
  const videoFilter = `${baseVideo};[composite]${encoderFilter(videoEncoding)}[vout]`;
  const output = ingestUrl === null
    ? ['-f', 'null', '-']
    : ['-f', 'flv', ingestUrl];
  return {
    executable,
    argv: [
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '1',
      ...encoderInputArguments(videoEncoding),
      ...input,
      '-thread_queue_size', '64', '-f', 'image2pipe', '-vcodec', 'png',
      '-framerate', `${outputFramesPerSecond}`, '-i', 'pipe:3',
      '-filter_complex', videoFilter, '-map', '[vout]', '-map', audioInput,
      ...encoderOutputArguments(videoEncoding, outputFramesPerSecond),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      ...output,
    ],
  } as const;
}

function attachProgress(
  session: InternalPilotSession,
  child: PilotChildProcess,
  onUnexpectedClose: (code: number | null) => void,
  onStatusChange: () => void,
): void {
  let progress: Record<string, string> = {};
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      progress[line.slice(0, separator)] = line.slice(separator + 1);
      if (line === 'progress=continue' || line === 'progress=end') {
        const encoder = encoderHealth(progress);
        if (encoder.frame > 0) session.retryAttempt = 0;
        const previousStatus = session.public.status;
        const status = session.public.status === 'starting'
          && session.public.mode === 'simulation'
          && encoder.frame > 0
          ? 'live'
          : session.public.status;
        session.public = PilotSessionSchema.parse({
          ...session.public,
          status,
          error: null,
          encoder,
        });
        if (status !== previousStatus) onStatusChange();
        progress = {};
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    session.diagnostic = `${session.diagnostic}${chunk}`.slice(-MAX_DIAGNOSTIC_LENGTH);
  });
  child.once('error', () => { session.diagnostic = `${session.diagnostic}\nNo se pudo iniciar FFmpeg.`; });
  child.once('close', (code) => {
    const requested = session.public.status === 'stopping';
    session.process = null;
    session.overlayController?.abort();
    session.overlayController = null;
    if (requested) {
      session.public = PilotSessionSchema.parse({
        ...session.public,
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
        error: null,
      });
      onStatusChange();
      return;
    }
    onUnexpectedClose(code);
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

function boundedDiagnostic(value: string, protectedUrl: string | null): string {
  const redacted = protectedUrl === null ? value : value.replaceAll(protectedUrl, '[entrada protegida]');
  const line = redacted.trim().split(/\r?\n/).at(-1)?.trim();
  return line ? `FFmpeg terminó: ${line.slice(0, 240)}` : 'FFmpeg terminó inesperadamente.';
}

function mapYouTubeError(error: unknown): PilotServiceError {
  if (error instanceof PilotYouTubeError) {
    const status = error.code === 'NOT_AUTHORIZED' || error.code === 'NOT_CONFIGURED' ? 409 : 502;
    return new PilotServiceError(status, 'NOT_READY', error.message);
  }
  return new PilotServiceError(502, 'RUNTIME_ERROR', 'YouTube no pudo preparar el directo.');
}
