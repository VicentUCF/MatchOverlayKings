import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  ClaimPilotMobileCameraInputSchema,
  CreatePilotMobileCameraInputSchema,
  PILOT_MOBILE_SOURCE_ID,
  PilotMobileCameraDesiredSchema,
  PilotMobileCameraLinkSchema,
  PilotMobileCameraSessionSchema,
  PilotMobileCameraStatusReportSchema,
  UpdatePilotMobileCameraDesiredInputSchema,
  type PilotMobileCameraCapabilities,
  type PilotMobileCameraDesired,
  type PilotMobileCameraLink,
  type PilotMobileCameraSession,
  type PilotMobileCameraStatusReport,
  type PilotSource,
} from '@kpl/production-contracts';
import type { PilotMobileCameraRuntimeConfig } from './config.js';
import type { PilotMobileRuntimeEvent } from './pilot-mobile-events.js';
import { MobileSnapshotSchema } from './pilot-mobile-state.js';
import { writePrivateJson } from './private-json.js';
import { encoderProcessIdentity, stopOrphanedEncoder } from './pilot-process-identity.js';

const TOKEN_TTL_MS = 12 * 60 * 60_000;
const HEARTBEAT_STALE_MS = 6_000;
const HEARTBEAT_OFFLINE_MS = 20_000;
const MEDIA_MTX_VERSION = '1.21.0';
const MOBILE_PATH = 'mobile-pilot';
const RUNTIME_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

type InternalSession = {
  readonly id: string;
  readonly courtSlug: PilotMobileCameraSession['courtSlug'];
  readonly tokenDigest: Buffer;
  readonly expiresAt: string;
  desired: PilotMobileCameraDesired;
  capabilities: PilotMobileCameraCapabilities | null;
  clientId: string | null;
  report: PilotMobileCameraStatusReport | null;
  lastHeartbeatAt: string | null;
  // Claims and heartbeats renew ownership; restored owners get the same grace period.
  ownershipUpdatedAt: number;
  degradedSamples: number;
  revoked: boolean;
  error: string | null;
  awaitingRevision: number | null;
};

type DesiredWaiter = {
  readonly sessionId: string;
  readonly resolve: (desired: PilotMobileCameraDesired) => void;
  readonly reject: (error: PilotMobileCameraError) => void;
  readonly timer: NodeJS.Timeout;
};

export type PilotMobileCameraErrorCode =
  | 'CONFLICT'
  | 'EXPIRED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'RUNTIME_ERROR';

export class PilotMobileCameraError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: PilotMobileCameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PilotMobileCameraError';
  }
}

export class PilotMobileCameraService {
  private readonly waiters = new Set<DesiredWaiter>();
  private readonly sessions = new Map<string, InternalSession>();
  private process: ChildProcess | null = null;
  private runtimePath: string | null = null;
  private mediaMtxVersion: string | null = null;
  private readonly expirationTimers = new Map<string, NodeJS.Timeout>();
  private mutation: Promise<unknown> = Promise.resolve();
  private runtimeReady = false;
  private runtimeError: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private retryExhausted = false;
  private stableSince: number | null = null;
  private shuttingDown = false;
  private storageLoaded = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthChecking = false;
  private healthFailures = 0;
  private runtimeObserver: ((event: PilotMobileRuntimeEvent) => void) | null = null;

  public constructor(
    private readonly config: PilotMobileCameraRuntimeConfig | undefined,
    private readonly dataDir: string,
    private readonly controlPort: number,
    private readonly readinessProbe: (port: number, child: ChildProcess) => Promise<void> = waitForMediaMtx,
    private readonly versionProbe: (executable: string) => boolean = hasExpectedMediaMtxVersion,
    private readonly now: () => number = Date.now,
    private readonly apiMutation: typeof mutateMediaMtx = mutateMediaMtx,
    private readonly runtimeHealthProbe: (port: number) => Promise<boolean> = apiReady,
  ) {}

  public observeRuntime(observer: (event: PilotMobileRuntimeEvent) => void): () => void {
    this.runtimeObserver = observer;
    // Also supports a runtime initialized before its operational journal attaches.
    if (this.activeSessions().length > 0) this.emitRuntime(this.runtimeReady ? 'ready'
      : this.retryExhausted ? this.available() ? 'exhausted' : 'configuration_unavailable' : 'starting');
    return () => { if (this.runtimeObserver === observer) this.runtimeObserver = null; };
  }

  private emitRuntime(code: PilotMobileRuntimeEvent['code'], sessions = this.activeSessions(), attempt = this.retryAttempt): void {
    if (!this.runtimeObserver || this.shuttingDown) return;
    const createdAt = new Date(this.now()).toISOString();
    for (const session of sessions) this.runtimeObserver({ id: randomUUID(), courtSlug: session.courtSlug,
      mobileSessionId: session.id, code, attempt, createdAt });
  }

  public async initialize(): Promise<void> {
    try {
      const snapshot = MobileSnapshotSchema.parse(JSON.parse(await readFile(this.snapshotPath(), 'utf8')));
      if (snapshot.runtimeProcess) await stopOrphanedEncoder(snapshot.runtimeProcess);
      for (const saved of snapshot.sessions) this.sessions.set(saved.id, {
        ...saved, tokenDigest: Buffer.from(saved.tokenDigest, 'hex'), report: null,
        lastHeartbeatAt: null, degradedSamples: 0, error: null, awaitingRevision: null,
        ownershipUpdatedAt: this.now(),
        revoked: saved.revoked || Date.parse(saved.expiresAt) <= this.now(),
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new PilotMobileCameraError(503, 'RUNTIME_ERROR', 'No se pudo recuperar el estado de las cámaras móviles. Conserva el archivo sessions.json y revisa el almacenamiento.');
      }
    }
    this.storageLoaded = true;
    const executable = this.config?.mediaMtxPath;
    if (this.configured() && executable !== null && executable !== undefined) {
      this.mediaMtxVersion = this.versionProbe(executable) ? MEDIA_MTX_VERSION : null;
    }
    for (const session of this.activeSessions()) this.scheduleExpiration(session);
    if (this.activeSessions().length > 0) {
      if (!this.available()) {
        this.runtimeError = 'Las cámaras están conservadas, pero MediaMTX o la red LAN no están disponibles.';
        this.retryExhausted = true;
        this.emitRuntime('configuration_unavailable');
        return;
      }
      try { await this.startMediaMtx(true); }
      catch { this.emitRuntime('start_failed'); await this.stopMediaMtx(); this.scheduleRuntimeRetry(); }
    }
  }

  private snapshotPath(): string { return join(this.dataDir, 'sessions.json'); }

  private persistSessions(replacement?: InternalSession): Promise<void> {
    return writePrivateJson(this.snapshotPath(), MobileSnapshotSchema.parse({
      version: 1, runtimeProcess: encoderProcessIdentity(this.process?.pid),
      sessions: [...this.sessions.values()].map((current) => {
        const session = current.id === replacement?.id ? replacement : current;
        return { id: session.id, courtSlug: session.courtSlug, tokenDigest: session.tokenDigest.toString('hex'),
          expiresAt: session.expiresAt, desired: session.desired, capabilities: session.capabilities,
          clientId: session.clientId, revoked: session.revoked };
      }),
    }));
  }

  private async commitSession(session: InternalSession, patch: Partial<InternalSession>): Promise<void> {
    const next = { ...session, ...patch };
    await this.persistSessions(next);
    Object.assign(session, patch);
  }

  private scheduleExpiration(session: InternalSession): void {
    clearTimeout(this.expirationTimers.get(session.id));
    const timer = setTimeout(() => {
      void this.revoke(session.id).catch(() => { session.error = 'No se pudo retirar la entrada móvil caducada.'; });
    }, Math.max(0, Date.parse(session.expiresAt) - this.now()));
    timer.unref();
    this.expirationTimers.set(session.id, timer);
  }

  public available(): boolean {
    return this.configured() && this.mediaMtxVersion === MEDIA_MTX_VERSION;
  }

  public source(): PilotSource | null {
    return this.available()
      ? { id: PILOT_MOBILE_SOURCE_ID, kind: 'mobile', label: 'Puerta de enlace · WebRTC' }
      : null;
  }

  public limitation(): string | null {
    if (!this.configured()) {
      return 'Configura MediaMTX y la red LAN para habilitar la cámara móvil.';
    }
    if (this.mediaMtxVersion !== MEDIA_MTX_VERSION) {
      return `MediaMTX ${MEDIA_MTX_VERSION} no está disponible para la cámara móvil.`;
    }
    return this.runtimeError;
  }

  public current(id?: string): PilotMobileCameraSession | null {
    const session = id === undefined ? [...this.sessions.values()].at(-1) : this.sessions.get(id);
    return session === undefined ? null : this.publicSession(session);
  }

  public list(): PilotMobileCameraSession[] {
    return [...this.sessions.values()].map((session) => this.publicSession(session));
  }

  public create(rawInput: unknown): Promise<PilotMobileCameraLink> {
    return this.serialize(() => this.createSession(rawInput));
  }

  private async createSession(rawInput: unknown): Promise<PilotMobileCameraLink> {
    const input = CreatePilotMobileCameraInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'La pista móvil no es válida.');
    if (!this.available() || this.config === undefined) {
      throw new PilotMobileCameraError(503, 'NOT_READY', 'La entrada móvil no está configurada.');
    }
    const previous = this.sessionForCourt(input.data.courtSlug);
    if (previous !== undefined && !previous.revoked && Date.parse(previous.expiresAt) > this.now()) {
      throw new PilotMobileCameraError(409, 'CONFLICT', 'Esta pista ya tiene un enlace de cámara móvil activo.');
    }

    if (previous !== undefined) {
      await this.revokeSession(previous.id);
      this.sessions.delete(previous.id);
    }
    const token = randomBytes(32).toString('base64url');
    const session: InternalSession = {
      id: randomUUID(),
      courtSlug: input.data.courtSlug,
      tokenDigest: digest(token),
      expiresAt: new Date(this.now() + TOKEN_TTL_MS).toISOString(),
      desired: PilotMobileCameraDesiredSchema.parse({
        revision: 1,
        cameraId: null,
        profile: '1080p30',
        audioEnabled: true,
      }),
      capabilities: null,
      clientId: null,
      report: null,
      lastHeartbeatAt: null,
      ownershipUpdatedAt: this.now(),
      degradedSamples: 0,
      revoked: false,
      error: null,
      awaitingRevision: null,
    };
    this.sessions.set(session.id, session);
    try { await this.persistSessions(); }
    catch (error) { this.sessions.delete(session.id); throw error; }
    const starting = this.process === null;
    try {
      if (starting) {
        const recovering = this.runtimeError !== null;
        if (this.retryTimer !== null) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retryAttempt = 0;
        await this.stopMediaMtx();
        await this.startMediaMtx(recovering);
      } else {
        await this.syncCredentials();
        await this.apiMutation(this.config.apiPort, 'POST', `/v3/config/paths/add/${mediaPath(session.id)}`, {
          source: 'publisher', overridePublisher: false,
        });
        this.emitRuntime('ready', [session]);
      }
    } catch {
      this.emitRuntime('start_failed', [session]);
      session.error = 'No se pudo habilitar la entrada móvil. Comprueba MediaMTX y vuelve a intentar.';
      session.revoked = true;
      await this.persistSessions();
      if (starting) await this.stopMediaMtx();
      else await this.revokeSession(session.id).catch(() => undefined);
      if (starting) this.scheduleRuntimeRetry();
      throw new PilotMobileCameraError(500, 'RUNTIME_ERROR', 'No se pudo iniciar MediaMTX para el móvil.');
    }
    this.scheduleExpiration(session);
    return PilotMobileCameraLinkSchema.parse({
      session: this.publicSession(session),
      connectUrl: this.connectUrl(session.id, token),
    });
  }

  public claim(id: string, token: string, rawInput: unknown) {
    return this.serialize(() => this.claimSession(id, token, rawInput));
  }

  private async claimSession(id: string, token: string, rawInput: unknown) {
    const session = this.authorize(id, token);
    const input = ClaimPilotMobileCameraInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'Las capacidades del móvil no son válidas.');
    if (session.clientId !== null && session.clientId !== input.data.clientId
      && this.now() - session.ownershipUpdatedAt <= HEARTBEAT_OFFLINE_MS) {
      throw new PilotMobileCameraError(409, 'CONFLICT', 'Este enlace ya está en uso por otro móvil.');
    }
    const supportsMinimum = input.data.capabilities.cameras.some(({ supportedProfiles }) =>
      supportedProfiles.includes('720p30'));
    if (!supportsMinimum) {
      throw new PilotMobileCameraError(409, 'NOT_READY', 'El móvil no ofrece el perfil mínimo 720p30.');
    }
    const selected = input.data.capabilities.cameras.find(({ id, supportedProfiles }) => id === session.desired.cameraId && supportedProfiles.includes(session.desired.profile))
      ?? input.data.capabilities.cameras.find(({ supportedProfiles }) =>
      supportedProfiles.includes('1080p30'))
      ?? input.data.capabilities.cameras.find(({ supportedProfiles }) => supportedProfiles.includes('720p30'));
    if (selected === undefined) throw new PilotMobileCameraError(409, 'NOT_READY', 'No hay una cámara compatible.');
    const profile = selected.id === session.desired.cameraId && selected.supportedProfiles.includes(session.desired.profile)
      ? session.desired.profile : selected.supportedProfiles.includes('1080p30') ? '1080p30' : '720p30';
    const desired = PilotMobileCameraDesiredSchema.parse({
      ...session.desired,
      revision: session.desired.revision + 1,
      cameraId: selected.id,
      profile,
      audioEnabled: session.desired.audioEnabled && input.data.capabilities.audioAvailable,
    });
    await this.commitSession(session, { clientId: input.data.clientId, capabilities: input.data.capabilities,
      desired, awaitingRevision: desired.revision, ownershipUpdatedAt: this.now(),
      report: null, error: null, degradedSamples: 0 });
    session.lastHeartbeatAt = new Date(this.now()).toISOString();
    this.flushWaiters(session.id, session.desired);
    return {
      desired: session.desired,
      whipUrl: this.whipUrl(session.id),
      whipUser: mediaUser(session.id),
    };
  }

  public async waitForDesired(id: string, token: string, afterRevision: number): Promise<PilotMobileCameraDesired> {
    const session = this.authorize(id, token);
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'La revisión solicitada no es válida.');
    }
    if (session.desired.revision > afterRevision) return session.desired;
    return new Promise((resolve, reject) => {
      const waiter: DesiredWaiter = {
        sessionId: session.id,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(session.desired);
        }, 20_000),
      };
      waiter.timer.unref();
      this.waiters.add(waiter);
    });
  }

  public report(id: string, token: string, rawInput: unknown): PilotMobileCameraSession {
    const session = this.authorize(id, token);
    const report = PilotMobileCameraStatusReportSchema.safeParse(rawInput);
    if (!report.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'El estado móvil no es válido.');
    if (session.clientId === null || session.clientId !== report.data.clientId) {
      throw new PilotMobileCameraError(403, 'FORBIDDEN', 'El móvil no ha reclamado esta sesión.');
    }
    session.report = report.data;
    if (session.awaitingRevision !== null && report.data.applied?.revision === session.awaitingRevision) session.awaitingRevision = null;
    session.lastHeartbeatAt = new Date(this.now()).toISOString();
    session.error = report.data.error;
    session.ownershipUpdatedAt = this.now();
    session.degradedSamples = isDegradedSample(session.desired, report.data)
      ? session.degradedSamples + 1
      : 0;
    return this.publicSession(session);
  }

  public updateDesired(id: string, rawInput: unknown): Promise<PilotMobileCameraSession> {
    return this.serialize(() => this.updateSessionDesired(id, rawInput));
  }

  private async updateSessionDesired(id: string, rawInput: unknown): Promise<PilotMobileCameraSession> {
    const session = this.requireSession(id);
    const input = UpdatePilotMobileCameraDesiredInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'La configuración móvil no es válida.');
    if (session.revoked || Date.parse(session.expiresAt) <= this.now()) {
      session.revoked = true;
      void this.revoke(session.id).catch(() => undefined);
      throw new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil ya no está activo.');
    }
    if (input.data.expectedRevision !== session.desired.revision) {
      throw new PilotMobileCameraError(409, 'CONFLICT', `La cámara cambió a la revisión ${session.desired.revision}.`);
    }
    const camera = session.capabilities?.cameras.find(({ id: cameraId }) => cameraId === input.data.cameraId);
    if (camera === undefined || !camera.supportedProfiles.includes(input.data.profile)) {
      throw new PilotMobileCameraError(409, 'NOT_READY', 'La cámara no admite ese perfil.');
    }
    if (input.data.audioEnabled && !session.capabilities?.audioAvailable) {
      throw new PilotMobileCameraError(409, 'NOT_READY', 'El móvil no ha concedido acceso al micrófono.');
    }
    const desired = PilotMobileCameraDesiredSchema.parse({
      revision: session.desired.revision + 1,
      cameraId: input.data.cameraId,
      profile: input.data.profile,
      audioEnabled: input.data.audioEnabled,
    });
    await this.commitSession(session, { desired, awaitingRevision: desired.revision });
    session.degradedSamples = 0;
    this.flushWaiters(session.id, session.desired);
    return this.publicSession(session);
  }

  public revoke(id: string): Promise<PilotMobileCameraSession> {
    return this.serialize(() => this.revokeSession(id));
  }

  private async revokeSession(id: string): Promise<PilotMobileCameraSession> {
    const session = this.requireSession(id);
    await this.commitSession(session, { revoked: true });
    session.error = null;
    clearTimeout(this.expirationTimers.get(id));
    this.expirationTimers.delete(id);
    this.rejectWaiters(new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil ha sido revocado.'), id);
    if (this.process !== null && this.config !== undefined) {
      try {
        // Remove the live path as well as credentials so existing publishers lose access.
        await this.apiMutation(this.config.apiPort, 'DELETE', `/v3/config/paths/delete/${mediaPath(id)}`);
        await this.syncCredentials();
      } catch {
        this.emitRuntime('revocation_restart');
        await this.stopMediaMtx();
        this.scheduleRuntimeRetry();
        throw new PilotMobileCameraError(503, 'RUNTIME_ERROR', 'El enlace está revocado. Se está recuperando el servicio para retirar su conexión anterior.');
      }
    }
    return this.publicSession(session);
  }

  public isReadyForCourt(courtSlug: string): boolean {
    const session = this.sessionForCourt(courtSlug);
    const current = session === undefined ? null : this.publicSession(session);
    return current?.courtSlug === courtSlug && ['ready', 'degraded'].includes(current.state);
  }

  public async checkRuntimeForCourt(courtSlug: string): Promise<boolean> {
    if (!this.config || !this.runtimeReady || !this.isReadyForCourt(courtSlug)) return false;
    return this.runtimeHealthProbe(this.config.apiPort).catch(() => false);
  }

  public audioAvailableForCourt(courtSlug: string): boolean {
    return this.sessionForCourt(courtSlug)?.capabilities?.audioAvailable === true;
  }

  public audioExpectedForCourt(courtSlug: string): boolean {
    const session = this.sessionForCourt(courtSlug);
    return session?.capabilities?.audioAvailable === true && session.desired.audioEnabled;
  }

  public framesPerSecondForCourt(courtSlug: string): 30 | 60 {
    return this.sessionForCourt(courtSlug)?.desired.profile.endsWith('60') ? 60 : 30;
  }

  public rtspUrl(courtSlug: string): string {
    if (this.config === undefined) throw new PilotMobileCameraError(503, 'NOT_READY', 'MediaMTX no está configurado.');
    const session = this.sessionForCourt(courtSlug);
    if (session === undefined || session.revoked || Date.parse(session.expiresAt) <= this.now()) {
      throw new PilotMobileCameraError(409, 'NOT_READY', 'La pista no tiene una entrada móvil activa.');
    }
    return `rtsp://127.0.0.1:${this.config.rtspPort}/${mediaPath(session.id)}`;
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.mutation;
    for (const timer of this.expirationTimers.values()) clearTimeout(timer);
    this.expirationTimers.clear();
    this.rejectWaiters(new PilotMobileCameraError(410, 'EXPIRED', 'El piloto se ha detenido.'));
    await this.stopMediaMtx();
    if (this.storageLoaded) await this.persistSessions();
  }

  private configured(): boolean {
    return this.config !== undefined
      && this.config.mediaMtxPath !== null
      && this.config.lanHost !== null
      && this.config.lanCidr !== null
      && validLanHost(this.config.lanHost)
      && validCidr(this.config.lanCidr)
      && /^https:\/\//.test(this.config.cameraPageOrigin);
  }

  private requireSession(id: string): InternalSession {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new PilotMobileCameraError(404, 'NOT_FOUND', 'No existe esa cámara móvil.');
    }
    return session;
  }

  private authorize(id: string, token: string): InternalSession {
    const session = this.requireSession(id);
    const candidate = digest(token);
    if (!timingSafeEqual(candidate, session.tokenDigest)) {
      throw new PilotMobileCameraError(403, 'FORBIDDEN', 'El enlace móvil no es válido.');
    }
    if (session.revoked || Date.parse(session.expiresAt) <= this.now()) {
      session.revoked = true;
      void this.revoke(session.id).catch(() => undefined);
      throw new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil ha caducado.');
    }
    return session;
  }

  private publicSession(session: InternalSession): PilotMobileCameraSession {
    const projected = projectedState(session, this.now());
    const runtimeFailed = !this.runtimeReady && this.runtimeError !== null;
    const state = projected === 'revoked' ? projected
      : runtimeFailed ? this.retryExhausted ? 'error' : 'reconnecting'
        : session.awaitingRevision !== null ? 'reconnecting' : projected;
    return PilotMobileCameraSessionSchema.parse({
      id: session.id,
      courtSlug: session.courtSlug,
      state,
      desired: session.desired,
      capabilities: session.capabilities,
      applied: session.report?.applied ?? null,
      metrics: session.report?.metrics ?? null,
      claimed: session.clientId !== null,
      lastHeartbeatAt: session.lastHeartbeatAt,
      expiresAt: session.expiresAt,
      error: runtimeFailed && state !== 'revoked' ? this.runtimeError : session.error,
      previewUrl: state === 'revoked' ? null : this.previewUrl(session.id),
    });
  }

  private connectUrl(id: string, token: string): string {
    if (this.config?.lanHost === null || this.config === undefined) throw new TypeError('LAN host unavailable');
    const url = new URL('/camera/pilot', this.config.cameraPageOrigin);
    url.hash = new URLSearchParams({
      endpoint: `http://${formatHost(this.config.lanHost)}:${this.controlPort}`,
      session: id,
      token,
    }).toString();
    return url.toString();
  }

  private whipUrl(id: string): string {
    if (this.config?.lanHost === null || this.config === undefined) throw new TypeError('LAN host unavailable');
    return `http://${formatHost(this.config.lanHost)}:${this.config.webRtcPort}/${mediaPath(id)}/whip`;
  }

  private previewUrl(id: string): string | null {
    return this.config === undefined
      ? null
      : `http://127.0.0.1:${this.config.webRtcPort}/${mediaPath(id)}/whep`;
  }

  private async startMediaMtx(recovering = false): Promise<void> {
    this.emitRuntime('starting');
    if (this.config?.mediaMtxPath === null || this.config?.lanHost === null
      || this.config?.lanCidr === null || this.config === undefined) {
      throw new TypeError('MediaMTX configuration unavailable');
    }
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const runtimePath = await mkdtemp(join(this.dataDir, 'pilot-mobile-mediamtx-'));
    this.runtimePath = runtimePath;
    const configPath = join(runtimePath, 'mediamtx.yml');
    const configuration = buildPilotMediaMtxConfiguration(this.config, this.activeSessions());
    await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    this.runtimeReady = false;
    const child = spawn(this.config.mediaMtxPath, [configPath], {
      cwd: runtimePath,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    this.process = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.once('close', () => {
      if (this.process === child) {
        const wasReady = this.runtimeReady;
        this.process = null;
        this.runtimeReady = false;
        if (wasReady) {
          this.emitRuntime('process_exit');
          if (this.stableSince !== null && this.now() - this.stableSince >= 30_000) this.retryAttempt = 0;
          this.scheduleRuntimeRetry();
        }
      }
    });
    child.once('error', () => {
      this.runtimeError = 'No se pudo ejecutar MediaMTX.';
    });
    await this.persistSessions();
    await this.readinessProbe(this.config.apiPort, child);
    if (this.process !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('MediaMTX exited during startup');
    if (recovering) for (const session of this.activeSessions()) {
      if (session.clientId === null) continue;
      session.desired = PilotMobileCameraDesiredSchema.parse({ ...session.desired, revision: session.desired.revision + 1 });
      session.awaitingRevision = session.desired.revision;
      session.report = null;
      session.error = null;
    }
    await this.persistSessions();
    if (this.process !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('MediaMTX exited while committing startup');
    this.runtimeReady = true;
    this.runtimeError = null;
    this.retryExhausted = false;
    this.stableSince = this.now();
    this.healthFailures = 0;
    this.emitRuntime(recovering ? 'restored' : 'ready');
    if (this.healthTimer === null) {
      this.healthTimer = setInterval(() => { void this.checkRuntimeHealth(); }, 5_000);
      this.healthTimer.unref();
    }
    if (recovering) for (const session of this.activeSessions()) this.flushWaiters(session.id, session.desired);
  }

  private async checkRuntimeHealth(): Promise<void> {
    const child = this.process;
    if (this.shuttingDown || this.healthChecking || !this.runtimeReady || child === null || this.config === undefined) return;
    this.healthChecking = true;
    try {
      const healthy = await this.runtimeHealthProbe(this.config.apiPort).catch(() => false);
      if (this.shuttingDown || this.process !== child || !this.runtimeReady) return;
      this.healthFailures = healthy ? 0 : this.healthFailures + 1;
      if (this.healthFailures < 3) return;
      await this.serialize(async () => {
        if (this.shuttingDown || this.process !== child || !this.runtimeReady) return;
        if (this.stableSince !== null && this.now() - this.stableSince >= 30_000) this.retryAttempt = 0;
        this.runtimeReady = false;
        this.runtimeError = 'MediaMTX no responde a las comprobaciones. Recuperando las cámaras.';
        this.emitRuntime('unresponsive');
        await this.stopMediaMtx();
        this.scheduleRuntimeRetry();
      });
    } catch {
      this.scheduleRuntimeRetry();
    } finally { this.healthChecking = false; }
  }

  /** Explicit operator recovery also works after the automatic retry budget expires. */
  public recoverRuntimeForCourt(courtSlug: string): Promise<void> {
    return this.serialize(async () => {
      if (this.shuttingDown) throw new PilotMobileCameraError(503, 'NOT_READY', 'El servicio móvil se está cerrando.');
      const session = this.sessionForCourt(courtSlug);
      if (!session || session.revoked || Date.parse(session.expiresAt) <= this.now()) return;
      if (this.runtimeReady) return;
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryAttempt = 0;
      this.emitRuntime('manual_recovery');
      await this.stopMediaMtx();
      try { await this.startMediaMtx(true); }
      catch {
        this.emitRuntime('start_failed');
        await this.stopMediaMtx();
        this.scheduleRuntimeRetry();
        throw new PilotMobileCameraError(503, 'NOT_READY', 'MediaMTX sigue sin responder. Se reintentará la recuperación.');
      }
    });
  }

  private scheduleRuntimeRetry(): void {
    if (this.shuttingDown || this.retryTimer !== null || this.activeSessions().length === 0) return;
    const delay = RUNTIME_RETRY_DELAYS[this.retryAttempt];
    if (delay === undefined) {
      this.retryExhausted = true;
      this.runtimeError = 'MediaMTX falló tras cinco reintentos. Comprueba el servicio y pulsa Recuperar emisión; si no hay emisión, renueva el enlace móvil.';
      this.emitRuntime('exhausted');
      return;
    }
    this.retryExhausted = false;
    this.runtimeError = `MediaMTX se detuvo. Recuperando las cámaras (intento ${this.retryAttempt + 1}/5).`;
    this.emitRuntime('retry_scheduled', this.activeSessions(), this.retryAttempt + 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.serialize(async () => {
        if (this.shuttingDown || this.runtimeReady || this.activeSessions().length === 0) return;
        this.retryAttempt += 1;
        this.emitRuntime('retrying');
        await this.stopMediaMtx();
        try { await this.startMediaMtx(true); }
        catch {
          this.emitRuntime('start_failed');
          await this.stopMediaMtx();
          this.scheduleRuntimeRetry();
        }
      }).catch(() => { this.scheduleRuntimeRetry(); });
    }, delay);
    this.retryTimer.unref();
  }

  private async stopMediaMtx(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.runtimeReady = false;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        await new Promise<void>((resolve, reject) => {
          let forced: NodeJS.Timeout | undefined;
          const timer = setTimeout(() => {
            forced = setTimeout(() => reject(new Error('MediaMTX did not stop')), 1_000);
            forced.unref();
            child.kill('SIGKILL');
          }, 3_000);
          timer.unref();
          child.once('close', () => { clearTimeout(timer); clearTimeout(forced); resolve(); });
          child.kill('SIGINT');
        });
      } catch (error) {
        // Retain ownership so the next attempt cannot launch a duplicate runtime.
        this.process = child;
        throw error;
      }
    }
    const runtimePath = this.runtimePath;
    this.runtimePath = null;
    if (runtimePath !== null) await rm(runtimePath, { recursive: true, force: true });
  }

  private flushWaiters(id: string, desired: PilotMobileCameraDesired): void {
    for (const waiter of this.waiters) {
      if (waiter.sessionId !== id) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(desired);
      this.waiters.delete(waiter);
    }
  }

  private rejectWaiters(error: PilotMobileCameraError, id?: string): void {
    for (const waiter of this.waiters) {
      if (id !== undefined && waiter.sessionId !== id) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.waiters.delete(waiter);
    }
  }

  private sessionForCourt(courtSlug: string): InternalSession | undefined {
    return [...this.sessions.values()].find((session) => session.courtSlug === courtSlug);
  }

  private activeSessions(): InternalSession[] {
    return [...this.sessions.values()].filter((session) => !session.revoked && Date.parse(session.expiresAt) > this.now());
  }

  private async syncCredentials(): Promise<void> {
    if (this.config === undefined) return;
    const { authInternalUsers } = buildPilotMediaMtxConfiguration(this.config, this.activeSessions());
    await this.apiMutation(this.config.apiPort, 'PATCH', '/v3/config/global/patch', { authInternalUsers });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => undefined);
    return result;
  }
}

function projectedState(session: InternalSession, now: number): PilotMobileCameraSession['state'] {
  if (session.revoked || Date.parse(session.expiresAt) <= now) return 'revoked';
  if (session.error !== null && session.report?.state === 'error') return 'error';
  if (session.clientId === null) return 'waiting_permission';
  if (session.lastHeartbeatAt === null) return 'connecting';
  const age = now - Date.parse(session.lastHeartbeatAt);
  if (age > HEARTBEAT_OFFLINE_MS) return 'offline';
  if (age > HEARTBEAT_STALE_MS) return 'reconnecting';
  if (session.degradedSamples >= 3) return 'degraded';
  return session.report?.state ?? 'connecting';
}

function isDegradedSample(desired: PilotMobileCameraDesired, report: PilotMobileCameraStatusReport): boolean {
  if (report.applied === null) return report.state === 'degraded';
  const expected = profileDimensions(desired.profile);
  return report.applied.revision !== desired.revision
    || report.applied.width !== expected.width
    || report.applied.height !== expected.height
    || report.applied.framesPerSecond < expected.framesPerSecond * 0.8
    || (report.metrics?.packetLossPercent ?? 0) > 5
    || (report.metrics?.roundTripTimeMs ?? 0) > 500;
}

function profileDimensions(profile: PilotMobileCameraDesired['profile']) {
  switch (profile) {
    case '720p30': return { width: 1280, height: 720, framesPerSecond: 30 };
    case '720p60': return { width: 1280, height: 720, framesPerSecond: 60 };
    case '1080p30': return { width: 1920, height: 1080, framesPerSecond: 30 };
    case '1080p60': return { width: 1920, height: 1080, framesPerSecond: 60 };
    default: return assertNever(profile);
  }
}

export function buildPilotMediaMtxConfiguration(
  config: PilotMobileCameraRuntimeConfig,
  sessions: readonly Pick<InternalSession, 'id' | 'tokenDigest'>[],
) {
  const previewReaderIps = [...new Set([
    '127.0.0.1',
    '::1',
    ...(config.adminHost !== null && config.adminHost !== undefined && isIP(config.adminHost) !== 0
      ? [config.adminHost]
      : []),
  ])];
  return {
    logDestinations: ['stdout'],
    logStructured: true,
    api: true,
    apiAddress: `127.0.0.1:${config.apiPort}`,
    rtsp: true,
    rtspAddress: `127.0.0.1:${config.rtspPort}`,
    rtspTransports: ['tcp'],
    rtmp: false,
    hls: false,
    webrtc: true,
    webrtcAddress: `:${config.webRtcPort}`,
    webrtcEncryption: false,
    webrtcAllowOrigins: [config.cameraPageOrigin, 'http://localhost:4310', 'http://127.0.0.1:4310'],
    webrtcLocalUDPAddress: `:${config.webRtcUdpPort}`,
    webrtcLocalTCPAddress: '',
    webrtcIPsFromInterfaces: false,
    webrtcAdditionalHosts: [config.lanHost],
    srt: false,
    moq: false,
    authMethod: 'internal',
    authInternalUsers: [{
      user: 'any',
      pass: '',
      ips: previewReaderIps,
      permissions: [{ action: 'api' }, ...sessions.map(({ id }) => ({ action: 'read', path: mediaPath(id) }))],
    }, ...sessions.map(({ id, tokenDigest }) => ({
      user: mediaUser(id),
      pass: `sha256:${tokenDigest.toString('base64')}`,
      ips: [config.lanCidr],
      permissions: [{ action: 'publish', path: mediaPath(id) }],
    }))],
    paths: Object.fromEntries(sessions.map(({ id }) => [mediaPath(id), { source: 'publisher', overridePublisher: false }])),
  };
}

function mediaPath(id: string): string { return `${MOBILE_PATH}-${id}`; }
function mediaUser(id: string): string { return `camera-${id}`; }

async function mutateMediaMtx(port: number, method: string, path: string, body?: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const active = request({
      host: '127.0.0.1', port, method, path, timeout: 3_000,
      headers: { 'Content-Type': 'application/json' },
    }, (response) => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => {
        const status = response.statusCode ?? 500;
        if ((status >= 200 && status < 300) || (method === 'DELETE' && status === 404)) resolve();
        else reject(new Error(`MediaMTX ${method} failed (${status})`));
      });
    });
    active.once('timeout', () => active.destroy(new Error('MediaMTX API timed out')));
    active.once('error', reject);
    active.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitForMediaMtx(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('MediaMTX exited during startup');
    if (await apiReady(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('MediaMTX readiness timed out');
}

function apiReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const active = request({
      host: '127.0.0.1', port, method: 'GET', path: '/v3/paths/list', timeout: 300,
    }, (response) => {
      response.resume();
      response.once('error', () => resolve(false));
      response.once('aborted', () => resolve(false));
      response.once('end', () => resolve(response.statusCode === 200));
    });
    active.once('timeout', () => { active.destroy(); resolve(false); });
    active.once('error', () => resolve(false));
    active.end();
  });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function hasExpectedMediaMtxVersion(executable: string): boolean {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  return probe.status === 0 && /(?:^|\s)v?1\.21\.0(?:\s|$)/.test(output);
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function validLanHost(host: string): boolean {
  if (host === 'localhost') return false;
  const version = isIP(host);
  if (version === 6) return isPrivateIpv6(host);
  if (version === 0) return host.endsWith('.local') || !host.includes('.');
  const parts = host.split('.').map(Number);
  return parts[0] === 10
    || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function validCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (address === undefined || prefix === undefined || rest.length > 0) return false;
  const version = isIP(address);
  const bits = Number(prefix);
  if (!Number.isInteger(bits)) return false;
  if (version === 4) {
    const parts = address.split('.').map(Number);
    return (parts[0] === 10 && bits >= 8 && bits <= 32)
      || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31 && bits >= 12 && bits <= 32)
      || (parts[0] === 192 && parts[1] === 168 && bits >= 16 && bits <= 32);
  }
  return version === 6 && bits >= (address.toLowerCase().startsWith('fe') ? 10 : 7)
    && bits <= 128 && isPrivateIpv6(address);
}

function isPrivateIpv6(address: string): boolean {
  const first = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
  return Number.isInteger(first) && ((first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf));
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected mobile profile: ${String(value)}`);
}
