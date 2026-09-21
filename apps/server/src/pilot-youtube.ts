import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { google } from 'googleapis';
import type { PilotPrivacy } from '@kpl/production-contracts';
import { YouTubePreparationError, YouTubePreparationTransaction, type PreparationCheckpoint, type YouTubePreparation } from './pilot-youtube-preparation.js';

const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

export type PilotYouTubeConfig = {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly redirectUri: string | null;
  readonly tokenPath: string | null;
};

export type PilotYouTubePreparedBroadcast = {
  readonly broadcastId: string;
  readonly streamId: string;
  readonly ingestUrl: string;
  readonly watchUrl: string;
};

export type PilotYouTubeHealth = {
  readonly streamStatus: string | null;
  readonly healthStatus: string | null;
  readonly broadcastStatus: string | null;
};

export type YouTubeUploadedVideo = {
  readonly id: string;
  readonly uploadStatus: string | null;
  readonly privacyStatus: string | null;
  readonly publishAt: string | null;
};

export class PilotYouTubeError extends Error {
  public constructor(
    public readonly code: 'NOT_CONFIGURED' | 'NOT_AUTHORIZED' | 'API_ERROR',
    apiMessage?: string,
  ) {
    super(apiMessage ?? (code === 'NOT_CONFIGURED'
      ? 'La integración de YouTube no está configurada.'
      : code === 'NOT_AUTHORIZED'
        ? 'Conecta primero la cuenta de YouTube.'
        : 'YouTube no pudo completar la operación.'));
    this.name = 'PilotYouTubeError';
  }
}

export class PilotYouTubeGateway {
  private readonly pendingStates = new Map<string, number>();
  private readonly oauth: InstanceType<typeof google.auth.OAuth2> | null;
  private authorized = false;

  public constructor(private readonly config: PilotYouTubeConfig) {
    const { clientId, clientSecret, redirectUri, tokenPath } = config;
    this.oauth = clientId !== null && clientSecret !== null && redirectUri !== null && tokenPath !== null
      ? new google.auth.OAuth2(clientId, clientSecret, redirectUri)
      : null;
    this.oauth?.on('tokens', (tokens) => {
      const current = this.oauth?.credentials ?? {};
      this.oauth?.setCredentials({ ...current, ...tokens });
      void this.persistTokens().catch(() => undefined);
    });
  }

  public get configured(): boolean {
    return this.config.clientId !== null && this.config.clientSecret !== null
      && this.config.redirectUri !== null && this.config.tokenPath !== null;
  }

  public get isAuthorized(): boolean {
    return this.authorized;
  }

  public async initialize(): Promise<void> {
    if (this.oauth === null || this.config.tokenPath === null) return;
    try {
      const parsed = JSON.parse(await readFile(this.config.tokenPath, 'utf8')) as unknown;
      if (!isTokenRecord(parsed)) return;
      this.oauth.setCredentials(parsed);
      this.authorized = true;
    } catch {
      this.authorized = false;
    }
  }

  public createAuthorizationUrl(): string {
    const oauth = this.requireConfigured();
    const state = randomBytes(24).toString('base64url');
    this.expireStates();
    this.pendingStates.set(state, Date.now() + 10 * 60_000);
    return oauth.generateAuthUrl({
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: 'consent',
      scope: [YOUTUBE_SCOPE],
      state,
    });
  }

  public async completeAuthorization(code: string, state: string): Promise<void> {
    const oauth = this.requireConfigured();
    this.expireStates();
    if (this.pendingStates.get(state) === undefined) throw new PilotYouTubeError('API_ERROR');
    this.pendingStates.delete(state);
    try {
      const { tokens } = await oauth.getToken(code);
      oauth.setCredentials(tokens);
      this.authorized = true;
      await this.persistTokens();
    } catch {
      throw new PilotYouTubeError('API_ERROR');
    }
  }

  public async prepareBroadcast(input: {
    readonly title: string;
    readonly description: string;
    readonly scheduledAt: string;
    readonly privacyStatus: PilotPrivacy;
    readonly thumbnail: Uint8Array;
    readonly framesPerSecond: 30 | 60;
    readonly recovery: YouTubePreparation;
    readonly checkpoint: PreparationCheckpoint;
    readonly signal?: AbortSignal;
  }): Promise<PilotYouTubePreparedBroadcast> {
    try {
      const state = await new YouTubePreparationTransaction(this.client(), input.recovery, input.checkpoint, input.signal).prepare(input);
      if (!state.broadcastId || !state.streamId || !state.ingestUrl) throw new PilotYouTubeError('API_ERROR');
      return { broadcastId: state.broadcastId, streamId: state.streamId, ingestUrl: state.ingestUrl,
        watchUrl: `https://www.youtube.com/watch?v=${state.broadcastId}` };
    } catch (error) { throw preparationError(error); }
  }

  public async inspectPreparation(state: YouTubePreparation, checkpoint: PreparationCheckpoint): Promise<YouTubePreparation> {
    try { return await new YouTubePreparationTransaction(this.client(), state, checkpoint).inspect(); }
    catch (error) { throw preparationError(error); }
  }

  public async cancelPreparation(state: YouTubePreparation, checkpoint: PreparationCheckpoint): Promise<void> {
    try { await new YouTubePreparationTransaction(this.client(), state, checkpoint).cancel(); }
    catch (error) { throw preparationError(error); }
  }

  public async health(broadcastId: string, streamId: string): Promise<PilotYouTubeHealth> {
    const youtube = this.client();
    try {
      const [streams, broadcasts] = await Promise.all([
        youtube.liveStreams.list({ id: [streamId], part: ['status'] }, { timeout: 8_000, retry: false }),
        youtube.liveBroadcasts.list({ id: [broadcastId], part: ['status'] }, { timeout: 8_000, retry: false }),
      ]);
      const stream = streams.data.items?.[0];
      const broadcast = broadcasts.data.items?.[0];
      return {
        streamStatus: stream?.status?.streamStatus ?? null,
        healthStatus: stream?.status?.healthStatus?.status ?? null,
        broadcastStatus: broadcast?.status?.lifeCycleStatus ?? null,
      };
    } catch {
      throw new PilotYouTubeError('API_ERROR');
    }
  }

  public async createResumableVideoUpload(input: {
    readonly title: string;
    readonly description: string;
    readonly sizeBytes: number;
  }): Promise<string> {
    const token = await this.accessToken();
    const response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(input.sizeBytes),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: { title: input.title, description: input.description, categoryId: '17' },
        status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
      }),
    });
    const location = response.headers.get('location');
    if (!response.ok || !location) throw new PilotYouTubeError('API_ERROR', await youtubeUploadMessage(response));
    return location;
  }

  public async queryResumableVideoUpload(uploadUrl: string, totalBytes: number): Promise<{
    readonly uploadedBytes: number;
    readonly videoId: string | null;
  }> {
    assertGoogleUploadUrl(uploadUrl);
    const response = await fetch(uploadUrl, {
      method: 'PUT', headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Length': '0', 'Content-Range': `bytes */${totalBytes}`,
      },
    });
    if (response.status === 308) return { uploadedBytes: uploadedRange(response), videoId: null };
    if (!response.ok) throw new PilotYouTubeError('API_ERROR', await youtubeUploadMessage(response));
    const payload = await response.json() as { id?: unknown };
    if (typeof payload.id !== 'string') throw new PilotYouTubeError('API_ERROR');
    return { uploadedBytes: totalBytes, videoId: payload.id };
  }

  public async uploadVideoChunk(input: {
    readonly uploadUrl: string;
    readonly path: string;
    readonly start: number;
    readonly end: number;
    readonly totalBytes: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly uploadedBytes: number; readonly videoId: string | null }> {
    assertGoogleUploadUrl(input.uploadUrl);
    const length = input.end - input.start + 1;
    const response = await fetch(input.uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'video/mp4',
        'Content-Length': String(length),
        'Content-Range': `bytes ${input.start}-${input.end}/${input.totalBytes}`,
      },
      body: createReadStream(input.path, { start: input.start, end: input.end }),
      signal: input.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (response.status === 308) return { uploadedBytes: uploadedRange(response), videoId: null };
    if (!response.ok) throw new PilotYouTubeError('API_ERROR', await youtubeUploadMessage(response));
    const payload = await response.json() as { id?: unknown };
    if (typeof payload.id !== 'string') throw new PilotYouTubeError('API_ERROR');
    return { uploadedBytes: input.totalBytes, videoId: payload.id };
  }

  public async inspectUploadedVideo(id: string): Promise<YouTubeUploadedVideo> {
    try {
      const response = await this.client().videos.list({ id: [id], part: ['status', 'processingDetails'] });
      const video = response.data.items?.[0];
      if (!video) throw new PilotYouTubeError('API_ERROR', 'YouTube ya no encuentra el vídeo subido.');
      return {
        id,
        uploadStatus: video.status?.uploadStatus ?? video.processingDetails?.processingStatus ?? null,
        privacyStatus: video.status?.privacyStatus ?? null,
        publishAt: video.status?.publishAt ?? null,
      };
    } catch (error) {
      if (error instanceof PilotYouTubeError) throw error;
      throw new PilotYouTubeError('API_ERROR', youtubeApiErrorMessage(error));
    }
  }

  public async scheduleUploadedVideo(id: string, publishAt: string): Promise<YouTubeUploadedVideo> {
    try {
      await this.client().videos.update({
        part: ['status'],
        requestBody: { id, status: { privacyStatus: 'private', publishAt } },
      });
      return this.inspectUploadedVideo(id);
    } catch (error) {
      throw new PilotYouTubeError('API_ERROR', youtubeApiErrorMessage(error));
    }
  }

  public async cancelBroadcast(broadcastId: string): Promise<void> {
    await this.completeBroadcast(broadcastId);
  }

  public async completeBroadcast(broadcastId: string): Promise<void> {
    const youtube = this.client();
    try {
      const current = await youtube.liveBroadcasts.list({ id: [broadcastId], part: ['status'] }, { timeout: 8_000, retry: false });
      const broadcast = current.data.items?.[0];
      if (!broadcast || ['complete', 'revoked'].includes(broadcast.status?.lifeCycleStatus ?? '')) return;
      if (['created', 'ready'].includes(broadcast.status?.lifeCycleStatus ?? '')) {
        await youtube.liveBroadcasts.delete({ id: broadcastId });
        return;
      }
      await youtube.liveBroadcasts.transition({
        id: broadcastId,
        broadcastStatus: 'complete',
        part: ['id', 'status'],
      });
    } catch {
      throw new PilotYouTubeError('API_ERROR');
    }
  }

  private client() {
    if (!this.authorized || this.oauth === null) throw new PilotYouTubeError('NOT_AUTHORIZED');
    return google.youtube({ version: 'v3', auth: this.oauth });
  }

  private async accessToken(): Promise<string> {
    const oauth = this.requireConfigured();
    if (!this.authorized) throw new PilotYouTubeError('NOT_AUTHORIZED');
    const token = await oauth.getAccessToken();
    if (!token.token) throw new PilotYouTubeError('NOT_AUTHORIZED');
    return token.token;
  }

  private requireConfigured() {
    if (this.oauth === null) throw new PilotYouTubeError('NOT_CONFIGURED');
    return this.oauth;
  }

  private expireStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.pendingStates) {
      if (expiresAt <= now) this.pendingStates.delete(state);
    }
  }

  private async persistTokens(): Promise<void> {
    if (this.oauth === null || this.config.tokenPath === null) return;
    const parent = dirname(this.config.tokenPath);
    const nonce = randomBytes(8).toString('hex');
    const temporary = `${this.config.tokenPath}.${process.pid}.${nonce}.tmp`;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(this.oauth.credentials)}\n`, { mode: 0o600 });
    await rename(temporary, this.config.tokenPath);
  }
}

export function youtubeApiErrorMessage(error: unknown): string {
  const reason = youtubeApiErrorReason(error);
  switch (reason) {
    case 'invalidScheduledStartTime':
      return 'La fecha y hora no son válidas para YouTube. Programa la emisión para un momento futuro.';
    case 'liveStreamingNotEnabled':
      return 'El canal de YouTube todavía no tiene habilitadas las emisiones en directo.';
    case 'livePermissionBlocked':
      return 'YouTube ha bloqueado temporalmente las emisiones en directo de este canal.';
    case 'insufficientLivePermissions':
      return 'La cuenta conectada no tiene permisos para crear emisiones en este canal.';
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return 'Se ha agotado la cuota diaria de la API de YouTube.';
    case 'userBroadcastsExceedLimit':
      return 'El canal tiene demasiadas emisiones activas o programadas. Finaliza o elimina alguna en YouTube Studio.';
    case 'userRequestsExceedRateLimit':
      return 'YouTube ha limitado temporalmente las solicitudes. Espera un momento y vuelve a intentarlo.';
    case 'invalidTitle':
      return 'YouTube ha rechazado el título de la emisión.';
    case 'invalidDescription':
      return 'YouTube ha rechazado la descripción de la emisión.';
    case 'authError':
    case 'invalidCredentials':
      return 'La autorización de YouTube ha caducado. Vuelve a conectar la cuenta.';
    default:
      return 'YouTube no pudo completar la operación.';
  }
}

function youtubeApiErrorReason(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const response = error.response;
  if (!isRecord(response)) return null;
  const data = response.data;
  if (!isRecord(data)) return null;
  const apiError = data.error;
  if (!isRecord(apiError) || !Array.isArray(apiError.errors)) return null;
  const first = apiError.errors[0];
  return isRecord(first) && typeof first.reason === 'string' ? first.reason : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTokenRecord(value: unknown): value is Record<string, string | number> {
  return typeof value === 'object' && value !== null
    && Object.values(value).every((item) => typeof item === 'string' || typeof item === 'number');
}

function assertGoogleUploadUrl(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new PilotYouTubeError('API_ERROR', 'La sesión de subida guardada no es válida.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.googleapis.com'
    || !parsed.pathname.startsWith('/upload/youtube/v3/videos')) {
    throw new PilotYouTubeError('API_ERROR', 'La sesión de subida guardada no pertenece a YouTube.');
  }
}

function uploadedRange(response: Response): number {
  const match = response.headers.get('range')?.match(/bytes=0-(\d+)/i);
  return match?.[1] ? Number(match[1]) + 1 : 0;
}

async function youtubeUploadMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: unknown } };
    if (typeof payload.error?.message === 'string') return `YouTube rechazó la subida: ${payload.error.message.slice(0, 300)}`;
  } catch { /* The bounded generic message below is safe for the operator. */ }
  return `YouTube rechazó la subida (${response.status}).`;
}

function preparationError(error: unknown): PilotYouTubeError {
  if (error instanceof PilotYouTubeError) return error;
  return new PilotYouTubeError('API_ERROR', error instanceof YouTubePreparationError ? error.message : youtubeApiErrorMessage(error));
}
