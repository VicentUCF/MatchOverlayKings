import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { createProductionAssets } from '@kpl/production-assets';
import {
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
  type PreparePilotSessionInput,
} from '@kpl/production-contracts';
import { PilotYouTubeError } from './pilot-youtube.js';
import type { PilotYouTubeGateway } from './pilot-youtube.js';

const MAX_ACTIVE_SESSIONS = 3;
const MAX_DIAGNOSTIC_LENGTH = 2_000;

type InternalPilotSession = {
  public: PilotSession;
  readonly thumbnail: Uint8Array;
  readonly streamId: string | null;
  readonly ingestUrl: string | null;
  process: PilotChildProcess | null;
  diagnostic: string;
  lastYouTubeCheckAt: number;
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
  private ffmpegVersion: string | null = null;

  public constructor(
    private readonly ffmpegPath: string,
    private readonly youtube: PilotYouTubeGateway,
    private readonly configurationPath: string,
  ) {}

  public async initialize(): Promise<void> {
    await this.youtube.initialize();
    await this.loadConfigurations();
    const probe = spawnSync(this.ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 5_000 });
    this.ffmpegVersion = probe.status === 0
      ? probe.stdout.split(/\r?\n/, 1)[0]?.trim() || null
      : null;
  }

  public configurations(): readonly PilotConfiguration[] {
    return PilotConfigurationsSchema.parse([...this.configurationByCourt.values()]);
  }

  public async configure(rawCourtSlug: unknown, rawInput: unknown): Promise<PilotConfiguration> {
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
    this.configurationByCourt.set(configuration.courtSlug, configuration);
    await this.persistConfigurations();
    return configuration;
  }

  public readiness(): PilotReadiness {
    const sources = discoverSources();
    const limitations: string[] = [];
    if (sources.every(({ kind }) => kind !== 'v4l2')) limitations.push('No se detectan cámaras V4L2. Puedes validar con la señal sintética.');
    if (!this.youtube.configured) limitations.push('Faltan las credenciales OAuth de Google para probar YouTube.');
    else if (!this.youtube.isAuthorized) limitations.push('La cuenta de YouTube todavía no está conectada.');
    return PilotReadinessSchema.parse({
      ffmpeg: { available: this.ffmpegVersion !== null, version: this.ffmpegVersion },
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

  public async prepare(rawInput: unknown): Promise<PilotSession> {
    const parsed = PreparePilotSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa los datos del directo.');
    const input = parsed.data;
    if (this.ffmpegVersion === null) throw new PilotServiceError(503, 'NOT_READY', 'FFmpeg no está disponible.');
    const source = this.readiness().sources.find(({ id }) => id === input.sourceId);
    if (source === undefined) throw new PilotServiceError(409, 'NOT_READY', 'La fuente seleccionada ya no está disponible.');
    if (source.kind === 'v4l2') {
      const sourceInUse = [...this.sessions.values()].some(({ public: session }) =>
        session.source.id === source.id && !['stopped', 'failed'].includes(session.status));
      if (sourceInUse) throw new PilotServiceError(409, 'CONFLICT', 'La cámara seleccionada ya está asignada a otra pista.');
    }
    const existing = [...this.sessions.values()].find(({ public: session }) =>
      session.courtSlug === input.courtSlug && !['stopped', 'failed'].includes(session.status));
    if (existing !== undefined) throw new PilotServiceError(409, 'CONFLICT', 'La pista ya tiene un piloto activo.');

    const assets = productionAssets(input);
    let youtubePrepared: Awaited<ReturnType<PilotYouTubeGateway['prepareBroadcast']>> | null = null;
    if (input.mode === 'youtube') {
      try {
        youtubePrepared = await this.youtube.prepareBroadcast({
          title: assets.title,
          description: assets.description,
          scheduledAt: input.scheduledAt,
          privacyStatus: input.privacyStatus,
          thumbnail: assets.pngBytes,
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
      diagnostic: '',
      lastYouTubeCheckAt: 0,
    });
    return session;
  }

  public async list(): Promise<readonly PilotSession[]> {
    await Promise.all([...this.sessions.values()].map((session) => this.refreshYouTubeHealth(session)));
    return [...this.sessions.values()].map(({ public: session }) => session);
  }

  public get(id: string): InternalPilotSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe esa sesión de piloto.');
    return session;
  }

  public start(id: string): PilotSession {
    const session = this.get(id);
    if (session.public.status !== 'prepared') {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no está preparada para emitir.');
    }
    const active = [...this.sessions.values()].filter(({ public: current }) =>
      ['starting', 'live', 'stopping'].includes(current.status)).length;
    if (active >= MAX_ACTIVE_SESSIONS) throw new PilotServiceError(409, 'CONFLICT', 'Ya hay tres salidas activas.');
    if (session.public.mode === 'youtube' && session.ingestUrl === null) {
      throw new PilotServiceError(409, 'NOT_READY', 'La entrada de YouTube no está preparada.');
    }

    const command = ffmpegCommand(this.ffmpegPath, session.public.source, session.ingestUrl);
    const child = spawn(command.executable, command.argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      shell: false,
    });
    session.process = child;
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: 'starting',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      error: null,
    });
    attachProgress(session, child);
    return session.public;
  }

  public async stop(id: string): Promise<PilotSession> {
    const session = this.get(id);
    if (!['starting', 'live'].includes(session.public.status)) {
      throw new PilotServiceError(409, 'CONFLICT', 'La sesión no está emitiendo.');
    }
    session.public = PilotSessionSchema.parse({ ...session.public, status: 'stopping' });
    const child = session.process;
    child?.kill('SIGTERM');
    if (child !== null) {
      const forceStop = setTimeout(() => {
        if (session.process === child) child.kill('SIGKILL');
      }, 3_000);
      forceStop.unref();
    }
    if (session.public.mode === 'youtube' && session.public.broadcastId !== null) {
      try {
        await this.youtube.completeBroadcast(session.public.broadcastId);
      } catch {
        // The encoder is still stopped locally; the next status refresh exposes the remote discrepancy.
      }
    }
    return session.public;
  }

  public thumbnail(id: string): Uint8Array {
    return this.get(id).thumbnail;
  }

  public async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) session.process?.kill('SIGTERM');
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
  const courtNumber = Number(input.courtSlug.slice(-1));
  return createProductionAssets({
    leagueName: 'Kings Padel League',
    seasonLabel: input.seasonLabel,
    matchdayLabel: 'Jornada',
    matchdayNumber: input.matchdayNumber,
    courtName: `Pista ${courtNumber}`,
    home: { name: input.homeTeam },
    away: { name: input.awayTeam },
    scheduledAt: input.scheduledAt,
    timeZone: 'Europe/Madrid',
    locale: 'es-ES',
    publicUrl: `https://live.kingspadelleague.com/live/${input.courtSlug}`,
    templateRevision: 'pilot-v1',
  });
}

function ffmpegCommand(executable: string, source: PilotSource, ingestUrl: string | null) {
  const input = source.kind === 'synthetic'
    ? ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    : ['-thread_queue_size', '512', '-f', 'v4l2', '-framerate', '30', '-video_size', '1920x1080', '-i', source.devicePath,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  const output = ingestUrl === null
    ? ['-f', 'null', '/dev/null']
    : ['-f', 'flv', ingestUrl];
  return {
    executable,
    argv: [
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '1',
      ...input,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      ...output,
    ],
  } as const;
}

function attachProgress(session: InternalPilotSession, child: PilotChildProcess): void {
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
        const status = session.public.status === 'starting'
          && session.public.mode === 'simulation'
          && encoder.frame > 0
          ? 'live'
          : session.public.status;
        session.public = PilotSessionSchema.parse({
          ...session.public,
          status,
          encoder,
        });
        progress = {};
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    session.diagnostic = `${session.diagnostic}${chunk}`.slice(-MAX_DIAGNOSTIC_LENGTH);
  });
  child.once('error', () => {
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: 'failed',
      stoppedAt: new Date().toISOString(),
      error: 'No se pudo iniciar FFmpeg.',
    });
    session.process = null;
  });
  child.once('close', (code) => {
    const requested = session.public.status === 'stopping';
    session.public = PilotSessionSchema.parse({
      ...session.public,
      status: requested ? 'stopped' : code === 0 ? 'stopped' : 'failed',
      stoppedAt: new Date().toISOString(),
      error: requested || code === 0 ? null : boundedDiagnostic(session.diagnostic, session.ingestUrl),
    });
    session.process = null;
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
