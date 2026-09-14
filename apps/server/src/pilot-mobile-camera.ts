import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const TOKEN_TTL_MS = 12 * 60 * 60_000;
const HEARTBEAT_STALE_MS = 6_000;
const HEARTBEAT_OFFLINE_MS = 20_000;
const MEDIA_MTX_VERSION = '1.21.0';
const MOBILE_PATH = 'mobile-pilot';
const WHIP_USER = 'camera';

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
  degradedSamples: number;
  revoked: boolean;
  error: string | null;
};

type DesiredWaiter = {
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
  private session: InternalSession | null = null;
  private process: ChildProcess | null = null;
  private runtimePath: string | null = null;
  private mediaMtxVersion: string | null = null;
  private expirationTimer: NodeJS.Timeout | null = null;
  private diagnostic = '';

  public constructor(
    private readonly config: PilotMobileCameraRuntimeConfig | undefined,
    private readonly dataDir: string,
    private readonly controlPort: number,
    private readonly readinessProbe: (port: number, child: ChildProcess) => Promise<void> = waitForMediaMtx,
    private readonly versionProbe: (executable: string) => boolean = hasExpectedMediaMtxVersion,
    private readonly now: () => number = Date.now,
  ) {}

  public initialize(): void {
    const executable = this.config?.mediaMtxPath;
    if (!this.configured() || executable === null || executable === undefined) return;
    this.mediaMtxVersion = this.versionProbe(executable) ? MEDIA_MTX_VERSION : null;
  }

  public available(): boolean {
    return this.configured() && this.mediaMtxVersion === MEDIA_MTX_VERSION;
  }

  public source(): PilotSource | null {
    return this.available()
      ? { id: PILOT_MOBILE_SOURCE_ID, kind: 'mobile', label: 'Móvil Android · WebRTC' }
      : null;
  }

  public limitation(): string | null {
    if (!this.configured()) {
      return 'Configura MediaMTX y la red LAN para habilitar la cámara móvil.';
    }
    if (this.mediaMtxVersion !== MEDIA_MTX_VERSION) {
      return `MediaMTX ${MEDIA_MTX_VERSION} no está disponible para la cámara móvil.`;
    }
    return null;
  }

  public current(): PilotMobileCameraSession | null {
    return this.session === null ? null : this.publicSession(this.session);
  }

  public async create(rawInput: unknown): Promise<PilotMobileCameraLink> {
    const input = CreatePilotMobileCameraInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'La pista móvil no es válida.');
    if (!this.available() || this.config === undefined) {
      throw new PilotMobileCameraError(503, 'NOT_READY', 'La entrada móvil no está configurada.');
    }
    if (this.session !== null && !this.session.revoked && Date.parse(this.session.expiresAt) > this.now()) {
      throw new PilotMobileCameraError(409, 'CONFLICT', 'Ya existe un enlace de cámara móvil activo.');
    }

    await this.stopMediaMtx();
    this.rejectWaiters(new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil anterior ya no está activo.'));
    if (this.expirationTimer !== null) clearTimeout(this.expirationTimer);
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
      degradedSamples: 0,
      revoked: false,
      error: null,
    };
    this.session = session;
    try {
      await this.startMediaMtx(token);
    } catch (error) {
      session.error = boundedError(error, this.diagnostic);
      session.revoked = true;
      throw new PilotMobileCameraError(500, 'RUNTIME_ERROR', 'No se pudo iniciar MediaMTX para el móvil.');
    }
    this.expirationTimer = setTimeout(() => { void this.expireSession(session.id); }, TOKEN_TTL_MS);
    this.expirationTimer.unref();
    return PilotMobileCameraLinkSchema.parse({
      session: this.publicSession(session),
      connectUrl: this.connectUrl(session.id, token),
    });
  }

  public claim(id: string, token: string, rawInput: unknown) {
    const session = this.authorize(id, token);
    const input = ClaimPilotMobileCameraInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'Las capacidades del móvil no son válidas.');
    if (session.clientId !== null && session.clientId !== input.data.clientId) {
      throw new PilotMobileCameraError(409, 'CONFLICT', 'Este enlace ya está en uso por otro móvil.');
    }
    const supportsMinimum = input.data.capabilities.cameras.some(({ supportedProfiles }) =>
      supportedProfiles.includes('720p30'));
    if (!supportsMinimum) {
      throw new PilotMobileCameraError(409, 'NOT_READY', 'El móvil no ofrece el perfil mínimo 720p30.');
    }
    session.clientId = input.data.clientId;
    session.capabilities = input.data.capabilities;
    const selected = input.data.capabilities.cameras.find(({ supportedProfiles }) =>
      supportedProfiles.includes('1080p30'))
      ?? input.data.capabilities.cameras.find(({ supportedProfiles }) => supportedProfiles.includes('720p30'));
    if (selected === undefined) throw new PilotMobileCameraError(409, 'NOT_READY', 'No hay una cámara compatible.');
    const profile = selected.supportedProfiles.includes('1080p30') ? '1080p30' : '720p30';
    session.desired = PilotMobileCameraDesiredSchema.parse({
      ...session.desired,
      revision: session.desired.revision + 1,
      cameraId: selected.id,
      profile,
      audioEnabled: session.desired.audioEnabled && input.data.capabilities.audioAvailable,
    });
    session.lastHeartbeatAt = new Date(this.now()).toISOString();
    this.flushWaiters(session.desired);
    return {
      desired: session.desired,
      whipUrl: this.whipUrl(),
      whipUser: WHIP_USER,
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
    session.lastHeartbeatAt = new Date(this.now()).toISOString();
    session.error = report.data.error;
    session.degradedSamples = isDegradedSample(session.desired, report.data)
      ? session.degradedSamples + 1
      : 0;
    return this.publicSession(session);
  }

  public updateDesired(id: string, rawInput: unknown): PilotMobileCameraSession {
    const session = this.requireSession(id);
    const input = UpdatePilotMobileCameraDesiredInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotMobileCameraError(400, 'INVALID_INPUT', 'La configuración móvil no es válida.');
    if (session.revoked || Date.parse(session.expiresAt) <= this.now()) {
      session.revoked = true;
      void this.stopMediaMtx().catch(() => undefined);
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
    session.desired = PilotMobileCameraDesiredSchema.parse({
      revision: session.desired.revision + 1,
      cameraId: input.data.cameraId,
      profile: input.data.profile,
      audioEnabled: input.data.audioEnabled,
    });
    session.degradedSamples = 0;
    this.flushWaiters(session.desired);
    return this.publicSession(session);
  }

  public async revoke(id: string): Promise<PilotMobileCameraSession> {
    const session = this.requireSession(id);
    session.revoked = true;
    session.error = null;
    if (this.expirationTimer !== null) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    this.rejectWaiters(new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil ha sido revocado.'));
    await this.stopMediaMtx();
    return this.publicSession(session);
  }

  public isReadyForCourt(courtSlug: string): boolean {
    const current = this.current();
    return current?.courtSlug === courtSlug && ['ready', 'degraded'].includes(current.state);
  }

  public audioAvailableForCourt(courtSlug: string): boolean {
    return this.session?.courtSlug === courtSlug && this.session.capabilities?.audioAvailable === true;
  }

  public framesPerSecondForCourt(courtSlug: string): 30 | 60 {
    if (this.session?.courtSlug !== courtSlug) return 30;
    return this.session.desired.profile.endsWith('60') ? 60 : 30;
  }

  public rtspUrl(): string {
    if (this.config === undefined) throw new PilotMobileCameraError(503, 'NOT_READY', 'MediaMTX no está configurado.');
    return `rtsp://127.0.0.1:${this.config.rtspPort}/${MOBILE_PATH}`;
  }

  public async shutdown(): Promise<void> {
    if (this.expirationTimer !== null) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    this.rejectWaiters(new PilotMobileCameraError(410, 'EXPIRED', 'El piloto se ha detenido.'));
    await this.stopMediaMtx();
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
    if (this.session === null || this.session.id !== id) {
      throw new PilotMobileCameraError(404, 'NOT_FOUND', 'No existe esa cámara móvil.');
    }
    return this.session;
  }

  private authorize(id: string, token: string): InternalSession {
    const session = this.requireSession(id);
    const candidate = digest(token);
    if (!timingSafeEqual(candidate, session.tokenDigest)) {
      throw new PilotMobileCameraError(403, 'FORBIDDEN', 'El enlace móvil no es válido.');
    }
    if (session.revoked || Date.parse(session.expiresAt) <= this.now()) {
      session.revoked = true;
      void this.stopMediaMtx().catch(() => undefined);
      throw new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil ha caducado.');
    }
    return session;
  }

  private publicSession(session: InternalSession): PilotMobileCameraSession {
    const state = projectedState(session, this.now());
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
      error: session.error,
      previewUrl: state === 'revoked' ? null : this.previewUrl(),
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

  private whipUrl(): string {
    if (this.config?.lanHost === null || this.config === undefined) throw new TypeError('LAN host unavailable');
    return `http://${formatHost(this.config.lanHost)}:${this.config.webRtcPort}/${MOBILE_PATH}/whip`;
  }

  private previewUrl(): string | null {
    return this.config === undefined
      ? null
      : `http://127.0.0.1:${this.config.webRtcPort}/${MOBILE_PATH}/whep`;
  }

  private async startMediaMtx(token: string): Promise<void> {
    if (this.config?.mediaMtxPath === null || this.config?.lanHost === null
      || this.config?.lanCidr === null || this.config === undefined) {
      throw new TypeError('MediaMTX configuration unavailable');
    }
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const runtimePath = await mkdtemp(join(this.dataDir, 'pilot-mobile-mediamtx-'));
    const configPath = join(runtimePath, 'mediamtx.yml');
    const configuration = buildPilotMediaMtxConfiguration(this.config, digest(token));
    await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    this.runtimePath = runtimePath;
    this.diagnostic = '';
    const child = spawn(this.config.mediaMtxPath, [configPath], {
      cwd: runtimePath,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    this.process = child;
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.diagnostic = `${this.diagnostic}${chunk}`.slice(-2_000);
    });
    child.once('close', () => {
      if (this.process === child) {
        this.process = null;
        if (this.session !== null && !this.session.revoked) {
          this.session.error = 'MediaMTX se detuvo de forma inesperada.';
        }
      }
    });
    child.once('error', () => {
      if (this.session !== null) this.session.error = 'No se pudo ejecutar MediaMTX.';
    });
    await this.readinessProbe(this.config.apiPort, child);
  }

  private async stopMediaMtx(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (child !== null && child.exitCode === null) {
      child.kill('SIGINT');
      await Promise.race([
        new Promise<void>((resolve) => child.once('close', () => resolve())),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
          }, 3_000);
          timer.unref();
        }),
      ]);
    }
    const runtimePath = this.runtimePath;
    this.runtimePath = null;
    if (runtimePath !== null) await rm(runtimePath, { recursive: true, force: true });
  }

  private flushWaiters(desired: PilotMobileCameraDesired): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(desired);
    }
    this.waiters.clear();
  }

  private rejectWaiters(error: PilotMobileCameraError): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private async expireSession(id: string): Promise<void> {
    if (this.session === null || this.session.id !== id || this.session.revoked) return;
    this.session.revoked = true;
    this.expirationTimer = null;
    this.rejectWaiters(new PilotMobileCameraError(410, 'EXPIRED', 'El enlace móvil ha caducado.'));
    await this.stopMediaMtx();
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

export function buildPilotMediaMtxConfiguration(config: PilotMobileCameraRuntimeConfig, tokenDigest: Buffer) {
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
      permissions: [{ action: 'api' }, { action: 'read', path: MOBILE_PATH }],
    }, {
      user: WHIP_USER,
      pass: `sha256:${tokenDigest.toString('base64')}`,
      ips: [config.lanCidr],
      permissions: [{ action: 'publish', path: MOBILE_PATH }],
    }],
    paths: { [MOBILE_PATH]: { source: 'publisher', overridePublisher: false } },
  };
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

function boundedError(error: unknown, diagnostic: string): string {
  const message = error instanceof Error ? error.message : 'Error desconocido';
  const detail = diagnostic.trim().split(/\r?\n/).at(-1)?.trim();
  return `${message}${detail ? `: ${detail}` : ''}`.slice(0, 500);
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected mobile profile: ${String(value)}`);
}
