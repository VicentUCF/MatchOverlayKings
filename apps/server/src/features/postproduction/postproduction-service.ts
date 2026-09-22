import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CreatePostproductionProjectInputSchema,
  PostproductionProjectSchema,
  PostproductionControlCommandInputSchema,
  PostproductionPlayheadInputSchema,
  RelinkPostproductionSourceInputSchema,
  SavePostproductionCheckpointInputSchema,
  type PostproductionAction,
  type PostproductionControlSnapshot,
  type PostproductionProject,
  type PostproductionSource,
} from '@kpl/production-contracts';
import { replayMatchActions, type MatchState, type Team } from '@kpl/shared';
import { writePrivateJson } from '../../core/private-json.js';
import type { RecordingLibrary } from '../recordings/recording-library.js';
import type { PilotOverlayRenderer } from '../pilot/pilot-overlay.js';
import { PilotServiceError } from '../pilot/pilot-service-error.js';
import { ffmpegEnvironment } from '../pilot/pilot-video-encoder.js';
import { resolvePostproductionSource } from './postproduction-source-browser.js';

const execFileAsync = promisify(execFile);

type RenderRuntime = {
  readonly projectId: string;
  readonly controller: AbortController;
  readonly token: string;
  state: MatchState;
  confirmedAt: number;
  clockMs: number;
};

type OperatorSession = {
  readonly token: string;
  readonly expiresAt: number;
};

export class PostproductionService {
  private readonly projects = new Map<string, PostproductionProject>();
  private readonly mediaTokens = new Map<string, { projectId: string; expiresAt: number; verified: boolean }>();
  private readonly operatorSessions = new Map<string, OperatorSession>();
  private readonly playheads = new Map<string, number>();
  private render: RenderRuntime | null = null;

  public constructor(
    private readonly dataDirectory: string,
    private readonly sourceRoot: string,
    private readonly outputRoot: string,
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
    private readonly baseUrl: string,
    private readonly cardSoundPath: string,
    private readonly renderer: PilotOverlayRenderer,
    private readonly recordings: RecordingLibrary,
    private readonly hasActiveProduction: () => boolean,
    private readonly onChange: () => void = () => undefined,
  ) {}

  public async initialize(): Promise<void> {
    await mkdir(this.projectsDirectory(), { recursive: true, mode: 0o700 });
    const entries = await readdir(this.projectsDirectory(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = PostproductionProjectSchema.parse(JSON.parse(await readFile(join(this.projectsDirectory(), entry.name), 'utf8')));
        const project = parsed.status === 'rendering'
          ? { ...parsed, status: 'failed' as const, revision: parsed.revision + 1, updatedAt: new Date().toISOString(),
            render: parsed.render ? {
              ...parsed.render, finishedAt: new Date().toISOString(), error: 'El render se interrumpió al reiniciar el runtime.',
            } : null }
          : parsed;
        this.projects.set(project.id, project);
        this.playheads.set(project.id, project.checkpoint.playheadMs);
        if (project !== parsed) await this.persist(project);
      } catch { /* A corrupt project is isolated; other projects remain available. */ }
    }
  }

  public list(): readonly PostproductionProject[] {
    return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public get(id: string): PostproductionProject {
    const project = this.projects.get(id);
    if (!project) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe ese proyecto de renovación.');
    return project;
  }

  public async create(rawInput: unknown): Promise<PostproductionProject> {
    const input = CreatePostproductionProjectInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa el vídeo y los datos del partido.');
    const sourcePath = await resolvePostproductionSource(this.sourceRoot, input.data.sourcePath)
      .catch((error: unknown) => { throw invalidSource(error); });
    const source = await this.inspectSource(sourcePath);
    const initialState = input.data.initialState as unknown as MatchState;
    assertMatchState(initialState);
    const now = new Date().toISOString();
    const id = randomUUID();
    const project = PostproductionProjectSchema.parse({
      id, status: 'editing', revision: 1, title: input.data.title, seasonLabel: input.data.seasonLabel,
      matchdayNumber: input.data.matchdayNumber, courtSlug: input.data.courtSlug, source,
      initialState, teams: input.data.teams, leagueSnapshot: input.data.leagueSnapshot ?? null,
      checkpoint: { playheadMs: 0, actions: [], state: initialState, reason: 'initial', savedAt: now },
      render: null, createdAt: now, updatedAt: now,
    });
    this.projects.set(id, project);
    this.playheads.set(id, 0);
    await this.persist(project);
    return project;
  }

  public async deleteProject(id: string): Promise<void> {
    const project = this.get(id);
    if (project.status === 'rendering' || this.render?.projectId === id) {
      throw new PilotServiceError(409, 'CONFLICT', 'Cancela el render antes de borrar el proyecto.');
    }
    await rm(join(this.projectsDirectory(), `${id}.json`), { force: true });
    this.projects.delete(id);
    this.playheads.delete(id);
    this.operatorSessions.delete(id);
    for (const [token, grant] of this.mediaTokens) {
      if (grant.projectId === id) this.mediaTokens.delete(token);
    }
    this.onChange();
  }

  public async checkpoint(id: string, rawInput: unknown): Promise<PostproductionProject> {
    const current = this.get(id);
    const input = SavePostproductionCheckpointInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'El checkpoint de renovación no es válido.');
    if (current.status === 'rendering') throw new PilotServiceError(409, 'CONFLICT', 'No se puede editar mientras se genera el MP4.');
    if (input.data.expectedRevision !== current.revision) throw new PilotServiceError(409, 'CONFLICT', 'El proyecto cambió en otra pestaña. Recarga antes de guardar.');
    validateActions(input.data.actions, current.source.durationSeconds);
    let state: MatchState;
    try { state = replayMatchActions(current.initialState as unknown as MatchState, input.data.actions); }
    catch (error) { throw new PilotServiceError(400, 'INVALID_INPUT', error instanceof Error ? error.message : 'La cronología no es válida.'); }
    const now = new Date().toISOString();
    const next = PostproductionProjectSchema.parse({
      ...current, status: current.status === 'ready' ? 'editing' : current.status,
      revision: current.revision + 1, render: current.status === 'ready' ? null : current.render,
      checkpoint: { playheadMs: input.data.playheadMs, actions: input.data.actions, state, reason: input.data.reason, savedAt: now },
      updatedAt: now,
    });
    this.projects.set(id, next);
    this.playheads.set(id, input.data.playheadMs);
    await this.persist(next);
    return next;
  }

  public issueOperatorAccess(id: string): { token: string; expiresAt: string } {
    const project = this.get(id);
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 18 * 60 * 60_000;
    this.operatorSessions.set(id, { token, expiresAt });
    this.playheads.set(id, this.playheads.get(id) ?? project.checkpoint.playheadMs);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  public updatePlayhead(id: string, rawInput: unknown): void {
    const project = this.get(id);
    const input = PostproductionPlayheadInputSchema.safeParse(rawInput);
    if (!input.success || input.data.playheadMs > Math.ceil(project.source.durationSeconds * 1_000)) {
      throw new PilotServiceError(400, 'INVALID_INPUT', 'La posición del vídeo no es válida.');
    }
    this.playheads.set(id, input.data.playheadMs);
  }

  public operatorSnapshot(id: string, token: string): PostproductionControlSnapshot {
    this.requireOperatorSession(id, token);
    const project = this.get(id);
    return {
      projectId: project.id,
      state: project.checkpoint.state,
      teams: project.teams,
      playheadMs: this.playheads.get(id) ?? project.checkpoint.playheadMs,
      revision: project.revision,
    };
  }

  public async operatorCommand(id: string, token: string, rawInput: unknown): Promise<PostproductionControlSnapshot> {
    this.requireOperatorSession(id, token);
    const input = PostproductionControlCommandInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'La orden del operador no es válida.');
    const current = this.get(id);
    if (current.status === 'rendering') throw new PilotServiceError(409, 'CONFLICT', 'No se puede editar mientras se genera el MP4.');
    const previousState = current.checkpoint.state as unknown as MatchState;
    if (current.checkpoint.actions.some(({ id: actionId }) => actionId === input.data.commandId)) {
      return this.operatorSnapshot(id, token);
    }
    if (input.data.expectedVersion !== previousState.version) {
      throw new PilotServiceError(409, 'CONFLICT', 'El marcador cambió. Se está actualizando el mando; repite la acción.');
    }
    const lastTimestampMs = current.checkpoint.actions.at(-1)?.timestampMs ?? 0;
    const playheadMs = Math.max(this.playheads.get(id) ?? current.checkpoint.playheadMs, lastTimestampMs);
    const action: PostproductionAction = {
      id: input.data.commandId,
      timestampMs: playheadMs,
      kind: input.data.kind,
      payload: input.data.payload,
    };
    let state: MatchState;
    try { state = replayMatchActions(previousState, [action]); }
    catch (error) { throw new PilotServiceError(400, 'INVALID_INPUT', error instanceof Error ? error.message : 'La orden no se puede aplicar.'); }
    const now = new Date().toISOString();
    const next = PostproductionProjectSchema.parse({
      ...current,
      status: current.status === 'ready' ? 'editing' : current.status,
      revision: current.revision + 1,
      render: current.status === 'ready' ? null : current.render,
      checkpoint: {
        playheadMs,
        actions: [...current.checkpoint.actions, action],
        state,
        reason: gameCount(state) > gameCount(previousState) ? 'game' : 'manual',
        savedAt: now,
      },
      updatedAt: now,
    });
    this.projects.set(id, next);
    await this.persist(next);
    return this.operatorSnapshot(id, token);
  }

  public issueMediaToken(id: string): string {
    this.get(id);
    const token = randomBytes(32).toString('hex');
    this.mediaTokens.set(token, { projectId: id, expiresAt: Date.now() + 12 * 60 * 60_000, verified: false });
    return token;
  }

  public async relink(id: string, rawInput: unknown): Promise<PostproductionProject> {
    const current = this.get(id);
    if (current.status === 'rendering') throw new PilotServiceError(409, 'CONFLICT', 'No se puede reenlazar mientras se genera el MP4.');
    const input = RelinkPostproductionSourceInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Selecciona un MP4 de la carpeta permitida.');
    const sourcePath = await resolvePostproductionSource(this.sourceRoot, input.data.sourcePath)
      .catch((error: unknown) => { throw invalidSource(error); });
    const source = await this.inspectSource(sourcePath);
    if (source.fingerprint !== current.source.fingerprint) {
      throw new PilotServiceError(409, 'CONFLICT', 'El MP4 seleccionado no coincide con la huella del original.');
    }
    const now = new Date().toISOString();
    const relinked = PostproductionProjectSchema.parse({
      ...current, source, revision: current.revision + 1, updatedAt: now,
    });
    this.projects.set(id, relinked);
    await this.persist(relinked);
    return relinked;
  }

  public async mediaPath(id: string, token: string): Promise<string> {
    const grant = this.mediaTokens.get(token);
    if (!grant || grant.projectId !== id || grant.expiresAt < Date.now()) {
      this.mediaTokens.delete(token);
      throw new PilotServiceError(401, 'FORBIDDEN', 'El acceso temporal al vídeo ha caducado.');
    }
    const path = await this.assertSourceUnchanged(this.get(id), !grant.verified);
    grant.verified = true;
    return path;
  }

  public renderState(id: string, token: string): { state: MatchState; teams: Team[]; leagueSnapshot: unknown; confirmedAt: number; clockMs: number } {
    const runtime = this.render;
    if (!runtime || runtime.projectId !== id || runtime.token !== token) throw new PilotServiceError(404, 'NOT_FOUND', 'El render ya no está activo.');
    const project = this.get(id);
    return { state: runtime.state, teams: project.teams as unknown as Team[], leagueSnapshot: project.leagueSnapshot, confirmedAt: Date.now(), clockMs: runtime.clockMs };
  }

  public async startRender(id: string): Promise<PostproductionProject> {
    const project = this.get(id);
    if (this.render) throw new PilotServiceError(409, 'CONFLICT', 'Ya se está generando otro vídeo renovado.');
    if (this.hasActiveProduction()) throw new PilotServiceError(409, 'CONFLICT', 'Detén las emisiones y grabaciones activas antes de generar el vídeo.');
    const sourcePath = await this.assertSourceUnchanged(project, true);
    const now = new Date().toISOString();
    const rendering = PostproductionProjectSchema.parse({
      ...project, status: 'rendering', revision: project.revision + 1, updatedAt: now,
      render: { progress: 0, startedAt: now, finishedAt: null, outputAssetId: null, error: null },
    });
    this.projects.set(id, rendering);
    await this.persist(rendering);
    const runtime: RenderRuntime = {
      projectId: id, controller: new AbortController(), token: randomBytes(32).toString('hex'),
      state: project.initialState as unknown as MatchState, confirmedAt: Date.now(), clockMs: 0,
    };
    this.render = runtime;
    void this.runRender(rendering, sourcePath, runtime).catch(async (error: unknown) => {
      await rm(this.temporaryOutput(id), { force: true });
      await this.failRender(id, error instanceof Error ? error.message : 'No se pudo generar el MP4.');
    }).finally(() => {
        if (this.render === runtime) this.render = null;
      });
    return rendering;
  }

  public async cancelRender(id: string): Promise<PostproductionProject> {
    const runtime = this.render;
    if (!runtime || runtime.projectId !== id) throw new PilotServiceError(409, 'CONFLICT', 'Este proyecto no se está renderizando.');
    runtime.controller.abort();
    return this.get(id);
  }

  public async shutdown(): Promise<void> {
    this.render?.controller.abort();
  }

  private requireOperatorSession(id: string, token: string): void {
    const session = this.operatorSessions.get(id);
    if (!session || session.token !== token || session.expiresAt < Date.now()) {
      this.operatorSessions.delete(id);
      throw new PilotServiceError(401, 'FORBIDDEN', 'El enlace del operador no es válido o ha caducado.');
    }
  }

  private async inspectSource(sourcePath: string): Promise<PostproductionSource> {
    const [probe, file, fingerprint] = await Promise.all([
      execFileAsync(this.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourcePath],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
      stat(sourcePath), hashFile(sourcePath),
    ]).catch((error: unknown) => { throw invalidSource(error); });
    const parsed = JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: Array<{
      codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
    }> };
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const durationSeconds = Number(parsed.format?.duration);
    if (!video?.width || !video.height || !(durationSeconds > 0)) throw new PilotServiceError(400, 'INVALID_INPUT', 'El MP4 no contiene vídeo reproducible.');
    const fps = frameRate(video.avg_frame_rate ?? video.r_frame_rate ?? '30/1');
    return {
      relativePath: relative(await resolveReal(this.sourceRoot), sourcePath).split('\\').join('/'),
      name: basename(sourcePath), sizeBytes: file.size, modifiedAt: file.mtime.toISOString(), fingerprint,
      durationSeconds, width: video.width, height: video.height, framesPerSecond: fps > 30 ? 60 : 30,
      hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio')),
    };
  }

  private async assertSourceUnchanged(project: PostproductionProject, verifyFingerprint = false): Promise<string> {
    const path = await resolvePostproductionSource(this.sourceRoot, project.source.relativePath)
      .catch(() => { throw new PilotServiceError(409, 'CONFLICT', 'El vídeo original no está disponible. Reenlázalo para continuar.'); });
    const info = await stat(path);
    if (info.size !== project.source.sizeBytes || info.mtime.toISOString() !== project.source.modifiedAt) {
      throw new PilotServiceError(409, 'CONFLICT', 'El vídeo original ha cambiado desde que se creó el proyecto.');
    }
    if (verifyFingerprint && await hashFile(path) !== project.source.fingerprint) {
      throw new PilotServiceError(409, 'CONFLICT', 'El vídeo original ya no coincide con la huella guardada.');
    }
    return path;
  }

  private async runRender(project: PostproductionProject, sourcePath: string, runtime: RenderRuntime): Promise<void> {
    const output = join(this.outputDirectory(), `${project.id}.mp4`);
    const temporary = this.temporaryOutput(project.id);
    await mkdir(this.outputDirectory(), { recursive: true, mode: 0o700 });
    await rm(temporary, { force: true });
    const fps = project.source.framesPerSecond;
    const soundEvents = existsSync(this.cardSoundPath) ? cardSoundEvents(project) : [];
    const soundInputs = soundEvents.flatMap((event) => ['-itsoffset', String(event.timestampMs / 1_000), '-i', this.cardSoundPath]);
    const audioInputs = [
      ...(project.source.hasAudio ? [{ index: 0, volume: 1 }] : []),
      ...soundEvents.map((event, index) => ({ index: index + 2, volume: event.volume })),
    ];
    const audioFilter = soundEvents.length > 0
      ? `;${audioInputs.map((input, index) => `[${input.index}:a]volume=${input.volume}[pa${index}]`).join(';')};${audioInputs.map((_input, index) => `[pa${index}]`).join('')}${audioInputs.length > 1 ? `amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0` : 'anull'}[aout]`
      : '';
    const videoFilter = "[1:v][0:v]scale2ref=w='min(main_w,main_h*16/9)':h='min(main_h,main_w*9/16)'[ov][base];[base][ov]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[vout]";
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '1',
      '-re', '-i', sourcePath,
      '-thread_queue_size', '64', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:3',
      ...soundInputs,
      '-filter_complex', `${videoFilter}${audioFilter}`,
      '-map', '[vout]', ...audioFilter ? ['-map', '[aout]'] : audioInputs.length === 1 ? ['-map', `${audioInputs[0]!.index}:a:0`] : [],
      '-t', String(project.source.durationSeconds), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', '-y', temporary,
    ];
    const child = spawn(this.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: ffmpegEnvironment(),
    });
    const abort = () => child.kill('SIGTERM');
    runtime.controller.signal.addEventListener('abort', abort, { once: true });
    const actions = [...project.checkpoint.actions].sort((a, b) => a.timestampMs - b.timestampMs);
    let actionIndex = 0;
    let startedAt: number | null = null;
    const clock = setInterval(() => {
      if (startedAt === null) return;
      runtime.clockMs = Math.min(Math.round(performance.now() - startedAt), Math.round(project.source.durationSeconds * 1_000));
      let changed = false;
      while (actions[actionIndex] && actions[actionIndex]!.timestampMs <= runtime.clockMs) {
        runtime.state = replayMatchActions(runtime.state, [actions[actionIndex]!]); actionIndex += 1; changed = true;
      }
      if (changed) runtime.confirmedAt = Date.now();
    }, 16);
    const pageUrl = `${this.baseUrl}/postproduction/${encodeURIComponent(project.id)}/overlay?token=${encodeURIComponent(runtime.token)}`;
    const overlayTask = this.renderer.start(child.stdio[3] as Writable, {
      courtSlug: project.courtSlug, framesPerSecond: fps, pageUrl,
      onState: (health) => { if (health.status === 'ready' && startedAt === null) startedAt = performance.now(); },
    }, runtime.controller.signal);
    let stdout = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split('\n'); stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('out_time_ms=')) continue;
        const microseconds = Number(line.slice('out_time_ms='.length));
        if (Number.isFinite(microseconds)) this.updateProgress(project.id, Math.min(0.999, microseconds / 1_000_000 / project.source.durationSeconds));
      }
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    let wasCancelled = false;
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    }).then((exitCode) => {
      wasCancelled = runtime.controller.signal.aborted;
      return exitCode;
    }).finally(() => {
      clearInterval(clock);
      runtime.controller.signal.removeEventListener('abort', abort);
      if (!runtime.controller.signal.aborted) runtime.controller.abort();
    });
    await overlayTask.catch(() => undefined);
    if (code !== 0) {
      await rm(temporary, { force: true });
      throw new Error(wasCancelled ? 'El render fue cancelado.' : boundedFfmpegError(stderr));
    }
    await this.validateRenderedOutput(temporary, project);
    await rename(temporary, output);
    const asset = await this.recordings.registerDerivedAsset({
      projectId: project.id, courtSlug: project.courtSlug, title: `${project.title} · Renovado`,
      seasonLabel: project.seasonLabel, matchdayNumber: project.matchdayNumber, path: output,
      storageRoot: this.outputDirectory(),
    });
    if (asset.state !== 'ready') throw new Error(asset.error ?? 'El MP4 generado no superó la validación.');
    const current = this.get(project.id);
    const now = new Date().toISOString();
    const ready = PostproductionProjectSchema.parse({
      ...current, status: 'ready', revision: current.revision + 1, updatedAt: now,
      render: { ...current.render!, progress: 1, finishedAt: now, outputAssetId: asset.id, error: null },
    });
    this.projects.set(project.id, ready); await this.persist(ready);
  }

  private updateProgress(id: string, progress: number): void {
    const project = this.projects.get(id);
    if (!project?.render || project.status !== 'rendering') return;
    this.projects.set(id, { ...project, render: { ...project.render, progress } });
    this.onChange();
  }

  private async failRender(id: string, message: string): Promise<void> {
    const project = this.projects.get(id);
    if (!project) return;
    const now = new Date().toISOString();
    if (message === 'El render fue cancelado.') {
      const cancelled = PostproductionProjectSchema.parse({
        ...project, status: 'editing', revision: project.revision + 1, updatedAt: now, render: null,
      });
      this.projects.set(id, cancelled); await this.persist(cancelled);
      return;
    }
    const failed = PostproductionProjectSchema.parse({
      ...project, status: 'failed', revision: project.revision + 1, updatedAt: now,
      render: project.render ? { ...project.render, finishedAt: now, error: message.slice(0, 500) } : null,
    });
    this.projects.set(id, failed); await this.persist(failed);
  }

  private projectsDirectory(): string { return resolve(this.dataDirectory, 'postproduction', 'projects'); }
  private outputDirectory(): string { return resolve(this.outputRoot); }
  private temporaryOutput(projectId: string): string { return join(this.outputDirectory(), `${projectId}.mp4.partial`); }
  private async validateRenderedOutput(path: string, project: PostproductionProject): Promise<void> {
    const probe = await execFileAsync(this.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: Array<{
      codec_type?: string; width?: number; height?: number;
    }> };
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const duration = Number(parsed.format?.duration);
    if (video?.width !== project.source.width || video.height !== project.source.height
      || !Number.isFinite(duration) || Math.abs(duration - project.source.durationSeconds) > 1) {
      throw new Error('El MP4 temporal no superó la validación de dimensiones y duración.');
    }
  }
  private async persist(project: PostproductionProject): Promise<void> {
    await writePrivateJson(join(this.projectsDirectory(), `${project.id}.json`), project); this.onChange();
  }
}

function validateActions(actions: readonly PostproductionAction[], durationSeconds: number): void {
  let previous = -1;
  for (const action of actions) {
    if (action.timestampMs < previous || action.timestampMs > Math.ceil(durationSeconds * 1_000)) {
      throw new PilotServiceError(400, 'INVALID_INPUT', 'Las acciones deben estar ordenadas dentro de la duración del vídeo.');
    }
    previous = action.timestampMs;
  }
}

function assertMatchState(value: MatchState): void {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !Array.isArray(value.sets)
    || !value.currentGame || typeof value.version !== 'number') {
    throw new PilotServiceError(400, 'INVALID_INPUT', 'El estado inicial del marcador no es válido.');
  }
}

function gameCount(state: MatchState): number {
  return state.sets.reduce((total, set) => total + set.homeGames + set.awayGames, 0);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path); stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolvePromise); stream.once('error', reject);
  });
  return hash.digest('hex');
}

function frameRate(value: string): number {
  const [left, right] = value.split('/').map(Number); return right ? (left ?? 30) / right : Number(value) || 30;
}

async function resolveReal(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises'); return realpath(path);
}

function invalidSource(error: unknown): PilotServiceError {
  return error instanceof PilotServiceError ? error
    : new PilotServiceError(400, 'INVALID_INPUT', error instanceof Error ? error.message : 'No se puede abrir el MP4.');
}

function boundedFfmpegError(stderr: string): string {
  const line = stderr.trim().split('\n').at(-1)?.trim();
  return line ? `FFmpeg no pudo generar el vídeo: ${line}`.slice(0, 500) : 'FFmpeg no pudo generar el vídeo renovado.';
}

function cardSoundEvents(project: PostproductionProject): Array<{ timestampMs: number; volume: number }> {
  let state = project.initialState as unknown as MatchState;
  const events: Array<{ timestampMs: number; volume: number }> = [];
  for (const action of project.checkpoint.actions) {
    if (action.kind === 'use_card' && state.overlaySettings.soundEnabled) {
      events.push({ timestampMs: action.timestampMs, volume: state.overlaySettings.soundVolume });
    }
    state = replayMatchActions(state, [action]);
  }
  return events;
}
