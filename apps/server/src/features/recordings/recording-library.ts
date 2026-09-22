import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
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
import { PilotServiceError } from '../pilot/pilot-service-error.js';
import { JsonRecordingSnapshotStore, type RecordingSnapshotStore } from './recording-snapshot-store.js';
import { PilotYouTubeError, type PilotYouTubeGateway } from '../pilot/pilot-youtube.js';
import {
  InMemoryPublicationTaskQueue,
  PUBLICATION_MAX_ATTEMPTS,
  retryBucket,
  retryDelay,
  type PublicationReconcileTask,
  type PublicationTaskOutcome,
  type PublicationTaskQueue,
} from '../../infrastructure/queues/publication-task-queue.js';

const execFileAsync = promisify(execFile);
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

type Snapshot = {
  readonly assets: readonly RecordingAsset[];
  readonly jobs: readonly PublicationJob[];
  readonly reconciliations: Readonly<Record<string, string>>;
  readonly deletedAssetIds: readonly string[];
};

export class RecordingLibrary {
  private assets = new Map<string, RecordingAsset>();
  private jobs = new Map<string, PublicationJob>();
  private reconciliations = new Map<string, string>();
  private deletedAssetIds = new Set<string>();
  private uploads = new Map<string, AbortController>();
  private queueRecoveryTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly path: string,
    private readonly ffprobePath: string,
    private readonly youtube: PilotYouTubeGateway,
    private readonly tasks: PublicationTaskQueue = new InMemoryPublicationTaskQueue(),
    private readonly onChange: () => void = () => undefined,
    private readonly snapshots: RecordingSnapshotStore = new JsonRecordingSnapshotStore(path),
  ) {}

  public async initialize(): Promise<void> {
    try {
      const parsed = await this.snapshots.read();
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid recording index');
      const snapshot = parsed as { assets?: unknown; jobs?: unknown; deletedAssetIds?: unknown };
      const assets = RecordingAssetsSchema.safeParse(snapshot.assets ?? []);
      const jobs = PublicationJobsSchema.safeParse(snapshot.jobs ?? []);
      const deletedAssetIds = parseDeletedAssetIds(snapshot.deletedAssetIds ?? []);
      if (!assets.success || !jobs.success || deletedAssetIds === null) throw new Error('Invalid recording index');
      this.assets = new Map(assets.data.map((asset) => [asset.id, asset]));
      this.deletedAssetIds = new Set(deletedAssetIds);
      this.jobs = new Map(jobs.data.map((job): [string, PublicationJob] => [job.id, job.state === 'uploading'
        ? { ...job, state: 'paused', error: 'La subida se pausó al reiniciar el runtime.' }
        : job]));
      await this.persist();
    } catch (error) {
      if (!isMissing(error)) {
        throw new PilotServiceError(500, 'RUNTIME_ERROR', 'No se pudo cargar el índice privado de grabaciones.');
      }
    }
    await this.tasks.start((task) => this.reconcilePublication(task));
    await Promise.all([...this.jobs.values()]
      .filter((job) => job.youtubeVideoId !== null && ['processing', 'scheduled'].includes(job.state))
      .map((job) => this.startReconciliation(job.id)));
    this.queueRecoveryTimer = setInterval(() => { void this.recoverUnavailableQueue(); }, 30_000);
    this.queueRecoveryTimer.unref();
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
      if (this.deletedAssetIds.has(id)) continue;
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
        origin: previous?.origin ?? 'recording', sourceProjectId: previous?.sourceProjectId ?? null,
      });
      this.assets.set(id, candidate);
      if (!active && candidate.state !== 'ready') await this.validate(id);
    }
    await this.persist();
  }

  public async registerDerivedAsset(input: {
    readonly projectId: string;
    readonly courtSlug: RecordingAsset['courtSlug'];
    readonly title: string;
    readonly seasonLabel: string;
    readonly matchdayNumber: number;
    readonly path: string;
    readonly storageRoot?: string;
  }): Promise<RecordingAsset> {
    this.assertOwnedPath(input.path, input.storageRoot ?? resolve(dirname(this.path), 'recordings'));
    const id = createHash('sha256').update(`${input.projectId}\0${input.path}`).digest('hex');
    const now = new Date().toISOString();
    const asset = RecordingAssetSchema.parse({
      id, sessionId: input.projectId, courtSlug: input.courtSlug, title: input.title,
      seasonLabel: input.seasonLabel, matchdayNumber: input.matchdayNumber, path: input.path,
      createdAt: now, finalizedAt: null, sizeBytes: null, durationSeconds: null, streams: [],
      state: 'validating', error: null, origin: 'renovated', sourceProjectId: input.projectId,
    });
    this.deletedAssetIds.delete(id);
    this.assets.set(id, asset);
    await this.validate(id);
    await this.persist();
    return this.assets.get(id)!;
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

  public async deleteAsset(assetId: string): Promise<void> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new PilotServiceError(404, 'NOT_FOUND', 'No existe esa grabación.');
    if (asset.state === 'recording') {
      throw new PilotServiceError(409, 'CONFLICT', 'Detén la grabación antes de borrarla.');
    }
    const jobs = [...this.jobs.values()].filter((job) => job.assetId === assetId);
    for (const job of jobs) this.uploads.get(job.id)?.abort();
    await rm(asset.path, { force: true });
    this.assets.delete(assetId);
    this.deletedAssetIds.add(assetId);
    for (const job of jobs) {
      this.jobs.delete(job.id);
      this.reconciliations.delete(job.id);
    }
    await this.persist();
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
        retryAt: null,
        watchUrl: `https://www.youtube.com/watch?v=${job.youtubeVideoId}`,
        error: null,
      });
      await this.persist();
      await this.startReconciliation(jobId);
      return next;
    } catch (error) {
      if (error instanceof PilotServiceError) throw error;
      throw mapYouTube(error);
    }
  }

  public async retryReconciliation(jobId: string): Promise<PublicationJob> {
    const job = this.requireJob(jobId);
    if (job.state !== 'reconciliation_failed' || !job.youtubeVideoId) {
      throw new PilotServiceError(409, 'CONFLICT', 'Esta publicación no necesita reintentar la comprobación de YouTube.');
    }
    const next = this.updateJob(jobId, {
      state: job.publishAt ? 'scheduled' : 'processing',
      retryAt: null,
      error: null,
    });
    await this.persist();
    await this.startReconciliation(jobId);
    return this.jobs.get(jobId) ?? next;
  }

  public async shutdown(): Promise<void> {
    if (this.queueRecoveryTimer !== null) clearInterval(this.queueRecoveryTimer);
    this.queueRecoveryTimer = null;
    for (const controller of this.uploads.values()) controller.abort();
    try { await this.tasks.close(); } finally { await this.persist(); }
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
      if (!(duration > 0) || !streams.some(({ kind }) => kind === 'video')) {
        throw new Error('El MP4 no contiene vídeo reproducible.');
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
      youtubeVideoId: videoId, watchUrl: `https://www.youtube.com/watch?v=${videoId}`, retryAt: null, error: null });
    await this.persist();
    await this.startReconciliation(jobId);
  }

  private async startReconciliation(jobId: string): Promise<void> {
    const token = randomUUID();
    this.reconciliations.set(jobId, token);
    await this.persist();
    try {
      await this.tasks.enqueue(jobId, token);
    } catch {
      const retryAt = new Date(Date.now() + 30_000).toISOString();
      this.updateJob(jobId, {
        retryAt,
        error: 'La publicación está guardada, pero la cola de trabajos no está disponible. Se reintentará automáticamente.',
      });
      await this.persist();
    }
  }

  private async recoverUnavailableQueue(): Promise<void> {
    const now = Date.now();
    const pending = [...this.jobs.values()].filter((job) =>
      ['processing', 'scheduled'].includes(job.state)
      && job.error?.startsWith('La publicación está guardada, pero la cola de trabajos')
      && (job.retryAt === undefined || job.retryAt === null || Date.parse(job.retryAt) <= now));
    for (const job of pending) await this.startReconciliation(job.id);
  }

  private async reconcilePublication(task: PublicationReconcileTask): Promise<PublicationTaskOutcome> {
    const job = this.jobs.get(task.jobId);
    if (this.reconciliations.get(task.jobId) !== task.token) return { kind: 'complete' };
    if (!job || !job.youtubeVideoId || !['processing', 'scheduled'].includes(job.state)) return { kind: 'complete' };
    try {
      const remote = await this.youtube.inspectUploadedVideo(job.youtubeVideoId);
      const state = remote.privacyStatus === 'public' ? 'published'
        : remote.publishAt ? 'scheduled'
          : remote.uploadStatus === 'processed' && remote.privacyStatus === 'private' ? 'private_ready' : 'processing';
      if (state === 'published' || state === 'private_ready') {
        this.reconciliations.delete(job.id);
        if (job.state !== state || job.publishAt !== remote.publishAt || job.error !== null || job.retryAt !== null) {
          this.updateJob(job.id, { state, publishAt: remote.publishAt, retryAt: null, error: null });
          await this.persist();
        }
        return { kind: 'complete' };
      }
      const requestedDelayMs = state === 'scheduled' && remote.publishAt
        ? Math.max(30_000, Date.parse(remote.publishAt) - Date.now() + 30_000)
        : retryDelay(task.attempt);
      const delayMs = retryBucket(requestedDelayMs);
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      if (job.state !== state || job.publishAt !== remote.publishAt || job.error !== null || job.retryAt !== retryAt) {
        this.updateJob(job.id, { state, publishAt: remote.publishAt, retryAt, error: null });
        await this.persist();
      }
      return { kind: 'retry', delayMs, resetAttempts: true };
    } catch (error) {
      const message = mapYouTube(error).message;
      if (task.attempt >= PUBLICATION_MAX_ATTEMPTS) {
        this.reconciliations.delete(job.id);
        this.updateJob(job.id, {
          state: 'reconciliation_failed',
          retryAt: null,
          error: `${message} La comprobación automática se detuvo tras agotar los reintentos.`.slice(0, 500),
        });
        await this.persist();
        return { kind: 'dead-letter', reason: 'attempts-exhausted' };
      }
      const delayMs = publicationErrorDelay(error, message, task.attempt);
      this.updateJob(job.id, { retryAt: new Date(Date.now() + delayMs).toISOString(), error: message });
      await this.persist();
      return { kind: 'retry', delayMs };
    }
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

  private async persist(): Promise<void> {
    const snapshot: Snapshot = {
      assets: this.listAssets(),
      jobs: this.listJobs(),
      reconciliations: Object.fromEntries(this.reconciliations),
      deletedAssetIds: [...this.deletedAssetIds].sort(),
    };
    await this.snapshots.write(snapshot);
    this.onChange();
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseDeletedAssetIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
    ? value
    : null;
}

function mapYouTube(error: unknown): PilotServiceError {
  const message = error instanceof PilotYouTubeError ? error.message : 'YouTube no pudo completar la publicación.';
  return new PilotServiceError(503, 'NOT_READY', message);
}

function publicationErrorDelay(error: unknown, message: string, attempt: number): number {
  if (error instanceof PilotYouTubeError && ['NOT_AUTHORIZED', 'NOT_CONFIGURED'].includes(error.code)) return 30 * 60_000;
  if (/cuota diaria|autorización.*caducad/i.test(message)) return 30 * 60_000;
  if (/limitado temporalmente/i.test(message)) return 5 * 60_000;
  return retryDelay(attempt);
}
