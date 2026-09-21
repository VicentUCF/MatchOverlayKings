import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  CreatePublicationJobInputSchema,
  PublicationJobsSchema,
  RecordingAssetsSchema,
  RecordingAssetSchema,
  SchedulePublicationInputSchema,
  type PilotConfiguration,
  type PilotSession,
  type PublicationJob,
  type RecordingAsset,
  type RecordingStream,
} from '@kpl/production-contracts';
import { writePrivateJson } from './private-json.js';
import { PilotServiceError } from './pilot-service.js';
import { PilotYouTubeError, type PilotYouTubeGateway } from './pilot-youtube.js';

const execFileAsync = promisify(execFile);
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

type Snapshot = { readonly assets: readonly RecordingAsset[]; readonly jobs: readonly PublicationJob[] };

export class RecordingLibrary {
  private assets = new Map<string, RecordingAsset>();
  private jobs = new Map<string, PublicationJob>();
  private uploads = new Map<string, AbortController>();

  public constructor(
    private readonly path: string,
    private readonly ffprobePath: string,
    private readonly youtube: PilotYouTubeGateway,
  ) {}

  public async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return;
      const snapshot = parsed as { assets?: unknown; jobs?: unknown };
      const assets = RecordingAssetsSchema.safeParse(snapshot.assets ?? []);
      const jobs = PublicationJobsSchema.safeParse(snapshot.jobs ?? []);
      if (!assets.success || !jobs.success) throw new Error('Invalid recording index');
      this.assets = new Map(assets.data.map((asset) => [asset.id, asset]));
      this.jobs = new Map(jobs.data.map((job): [string, PublicationJob] => [job.id, job.state === 'uploading'
        ? { ...job, state: 'paused', error: 'La subida se pausó al reiniciar el runtime.' }
        : job]));
      await this.persist();
      await this.refreshRemoteStates();
    } catch (error) {
      if (isMissing(error)) return;
      throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo cargar el índice privado de grabaciones.');
    }
  }

  public listAssets(): readonly RecordingAsset[] {
    return [...this.assets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public listJobs(): readonly PublicationJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public async reconcileSession(session: PilotSession, configurations: readonly PilotConfiguration[]): Promise<void> {
    if (session.mode !== 'recording') return;
    const configuration = configurations.find(({ courtSlug }) => courtSlug === session.courtSlug);
    if (!configuration) return;
    for (const filePath of session.recordingFiles ?? []) {
      this.assertOwnedPath(filePath, configuration.recordingDirectory ?? resolve(dirname(this.path), 'recordings'));
      const id = createHash('sha256').update(`${session.id}\0${filePath}`).digest('hex');
      const previous = this.assets.get(id);
      const active = session.status !== 'stopped';
      const candidate = RecordingAssetSchema.parse({
        id, sessionId: session.id, courtSlug: session.courtSlug, title: session.title,
        seasonLabel: configuration.seasonLabel, matchdayNumber: configuration.matchdayNumber,
        path: filePath, createdAt: previous?.createdAt ?? new Date().toISOString(),
        finalizedAt: active ? null : previous?.finalizedAt ?? new Date().toISOString(),
        sizeBytes: previous?.sizeBytes ?? null, durationSeconds: previous?.durationSeconds ?? null,
        streams: previous?.streams ?? [], state: active ? 'recording' : previous?.state ?? 'validating',
        error: active ? null : previous?.error ?? null,
      });
      this.assets.set(id, candidate);
      if (!active && candidate.state !== 'ready') await this.validate(id);
    }
    await this.persist();
  }

  public async createUpload(assetId: string, rawInput: unknown): Promise<PublicationJob> {
    const input = CreatePublicationJobInputSchema.safeParse(rawInput);
    if (!input.success) throw new PilotServiceError(400, 'INVALID_INPUT', 'Revisa el título y la descripción del vídeo.');
    const asset = this.requireReadyAsset(assetId);
    const existing = [...this.jobs.values()].find((job) => job.assetId === assetId
      && !['failed'].includes(job.state));
    if (existing) return existing;
    const now = new Date().toISOString();
    const job: PublicationJob = {
      id: randomUUID(), assetId, state: 'uploading', title: input.data.title,
      description: input.data.description, uploadUrl: null, uploadedBytes: 0,
      totalBytes: asset.sizeBytes!, youtubeVideoId: null, watchUrl: null,
      publishAt: null, createdAt: now, updatedAt: now, error: null,
    };
    this.jobs.set(job.id, job);
    await this.persist();
    this.startUpload(job.id);
    return job;
  }

  public async pause(jobId: string): Promise<PublicationJob> {
    const job = this.requireJob(jobId);
    if (job.state !== 'uploading') return job;
    this.uploads.get(jobId)?.abort();
    const next = this.updateJob(jobId, { state: 'paused', error: null });
    await this.persist();
    return next;
  }

  public async resume(jobId: string): Promise<PublicationJob> {
    const job = this.requireJob(jobId);
    if (!['paused', 'failed'].includes(job.state) || job.youtubeVideoId) {
      throw new PilotServiceError(409, 'CONFLICT', 'Esta publicación no se puede reanudar.');
    }
    const next = this.updateJob(jobId, { state: 'uploading', error: null });
    await this.persist();
    this.startUpload(jobId);
    return next;
  }

  public async schedule(jobId: string, rawInput: unknown): Promise<PublicationJob> {
    const parsed = SchedulePublicationInputSchema.safeParse(rawInput);
    if (!parsed.success || Date.parse(parsed.data.publishAt) <= Date.now()) {
      throw new PilotServiceError(400, 'INVALID_INPUT', 'Elige una fecha futura para publicar el vídeo.');
    }
    const job = this.requireJob(jobId);
    if (!['private_ready', 'scheduled'].includes(job.state) || !job.youtubeVideoId) {
      throw new PilotServiceError(409, 'NOT_READY', 'Espera a que YouTube termine de procesar el vídeo privado.');
    }
    try {
      const current = await this.youtube.inspectUploadedVideo(job.youtubeVideoId);
      if (current.privacyStatus !== 'private' || current.uploadStatus !== 'processed') {
        throw new PilotServiceError(409, 'NOT_READY', 'Solo se puede programar un vídeo privado que YouTube haya procesado correctamente.');
      }
      const remote = await this.youtube.scheduleUploadedVideo(job.youtubeVideoId, parsed.data.publishAt);
      const next = this.updateJob(jobId, {
        state: remote.privacyStatus === 'public' ? 'published' : 'scheduled',
        publishAt: remote.publishAt ?? parsed.data.publishAt,
        watchUrl: `https://www.youtube.com/watch?v=${job.youtubeVideoId}`,
        error: null,
      });
      await this.persist();
      return next;
    } catch (error) {
      if (error instanceof PilotServiceError) throw error;
      throw mapYouTube(error);
    }
  }

  public async refreshRemoteStates(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (!job.youtubeVideoId || !['processing', 'private_ready', 'scheduled'].includes(job.state)) continue;
      try {
        const remote = await this.youtube.inspectUploadedVideo(job.youtubeVideoId);
        const state = remote.privacyStatus === 'public' ? 'published'
          : remote.publishAt ? 'scheduled'
            : remote.uploadStatus === 'processed' && remote.privacyStatus === 'private' ? 'private_ready' : 'processing';
        this.updateJob(job.id, { state, publishAt: remote.publishAt, error: null });
      } catch (error) {
        this.updateJob(job.id, { error: mapYouTube(error).message });
      }
    }
    await this.persist();
  }

  public async shutdown(): Promise<void> {
    for (const controller of this.uploads.values()) controller.abort();
    await this.persist();
  }

  private async validate(id: string): Promise<void> {
    const asset = this.assets.get(id);
    if (!asset) return;
    this.assets.set(id, { ...asset, state: 'validating', error: null });
    try {
      const [info, file] = await Promise.all([
        execFileAsync(this.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', asset.path],
          { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
        stat(asset.path),
      ]);
      const parsed = JSON.parse(info.stdout) as {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
      };
      const duration = Number(parsed.format?.duration);
      const streams: RecordingStream[] = [];
      for (const stream of parsed.streams ?? []) {
        if (stream.codec_type === 'video' && stream.codec_name) streams.push({
          kind: 'video', codec: stream.codec_name,
          ...(stream.width ? { width: stream.width } : {}), ...(stream.height ? { height: stream.height } : {}),
        });
        if (stream.codec_type === 'audio' && stream.codec_name) streams.push({ kind: 'audio', codec: stream.codec_name });
      }
      if (!(duration > 0) || !streams.some(({ kind }) => kind === 'video') || !streams.some(({ kind }) => kind === 'audio')) {
        throw new Error('El MP4 no contiene vídeo y audio reproducibles.');
      }
      this.assets.set(id, RecordingAssetSchema.parse({ ...asset, state: 'ready', finalizedAt: new Date().toISOString(),
        sizeBytes: file.size, durationSeconds: duration, streams, error: null }));
    } catch (error) {
      this.assets.set(id, RecordingAssetSchema.parse({ ...asset, state: 'invalid', finalizedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message.slice(0, 500) : 'No se pudo validar el MP4.' }));
    }
  }

  private startUpload(jobId: string): void {
    if (this.uploads.has(jobId)) return;
    const controller = new AbortController();
    this.uploads.set(jobId, controller);
    void this.runUpload(jobId, controller.signal).catch(async (error: unknown) => {
      if (controller.signal.aborted) return;
      this.updateJob(jobId, { state: 'failed', error: mapYouTube(error).message });
      await this.persist();
    }).finally(() => this.uploads.delete(jobId));
  }

  private async runUpload(jobId: string, signal: AbortSignal): Promise<void> {
    let job = this.requireJob(jobId);
    const asset = this.requireReadyAsset(job.assetId);
    let uploadUrl = job.uploadUrl;
    if (!uploadUrl) {
      uploadUrl = await this.youtube.createResumableVideoUpload({ title: job.title, description: job.description, sizeBytes: job.totalBytes });
      job = this.updateJob(jobId, { uploadUrl });
      await this.persist();
    } else {
      const remote = await this.youtube.queryResumableVideoUpload(uploadUrl, job.totalBytes);
      job = this.updateJob(jobId, { uploadedBytes: remote.uploadedBytes, youtubeVideoId: remote.videoId });
      await this.persist();
      if (remote.videoId) { await this.completeUpload(jobId, remote.videoId); return; }
    }
    while (!signal.aborted && job.uploadedBytes < job.totalBytes) {
      const end = Math.min(job.totalBytes - 1, job.uploadedBytes + UPLOAD_CHUNK_BYTES - 1);
      const result = await this.youtube.uploadVideoChunk({ uploadUrl, path: asset.path, start: job.uploadedBytes,
        end, totalBytes: job.totalBytes, signal });
      job = this.updateJob(jobId, { uploadedBytes: result.uploadedBytes, youtubeVideoId: result.videoId });
      await this.persist();
      if (result.videoId) { await this.completeUpload(jobId, result.videoId); return; }
    }
  }

  private async completeUpload(jobId: string, videoId: string): Promise<void> {
    this.updateJob(jobId, { state: 'processing', uploadedBytes: this.requireJob(jobId).totalBytes,
      youtubeVideoId: videoId, watchUrl: `https://www.youtube.com/watch?v=${videoId}`, error: null });
    await this.persist();
    await this.refreshRemoteStates();
  }

  private updateJob(id: string, patch: Partial<PublicationJob>): PublicationJob {
    const current = this.requireJob(id);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as PublicationJob;
    this.jobs.set(id, next);
    return next;
  }

  private requireReadyAsset(id: string): RecordingAsset {
    const asset = this.assets.get(id);
    if (!asset) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe esa grabación.');
    if (asset.state !== 'ready' || asset.sizeBytes === null) {
      throw new PilotServiceError(409, 'NOT_READY', 'La grabación todavía no es un MP4 validado.');
    }
    return asset;
  }

  private requireJob(id: string): PublicationJob {
    const job = this.jobs.get(id);
    if (!job) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe esa publicación.');
    return job;
  }

  private assertOwnedPath(filePath: string, root: string): void {
    if (!isAbsolute(filePath) || !isAbsolute(root)) throw new PilotServiceError(500, 'RUNTIME_ERROR', 'La ruta de grabación no es segura.');
    const inside = relative(resolve(root), resolve(filePath));
    if (inside.startsWith('..') || isAbsolute(inside)) throw new PilotServiceError(500, 'RUNTIME_ERROR', 'La grabación está fuera de la carpeta configurada.');
  }

  private persist(): Promise<void> {
    const snapshot: Snapshot = { assets: this.listAssets(), jobs: this.listJobs() };
    return writePrivateJson(this.path, snapshot);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function mapYouTube(error: unknown): PilotServiceError {
  const message = error instanceof PilotYouTubeError ? error.message : 'YouTube no pudo completar la publicación.';
  return new PilotServiceError(503, 'NOT_READY', message);
}
