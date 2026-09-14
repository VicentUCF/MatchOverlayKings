import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { PilotPrivacy } from '@kpl/production-contracts';

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

export class PilotYouTubeError extends Error {
  public constructor(public readonly code: 'NOT_CONFIGURED' | 'NOT_AUTHORIZED' | 'API_ERROR') {
    super(code === 'NOT_CONFIGURED'
      ? 'La integración de YouTube no está configurada.'
      : code === 'NOT_AUTHORIZED'
        ? 'Conecta primero la cuenta de YouTube.'
        : 'YouTube no pudo completar la operación.');
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
  }): Promise<PilotYouTubePreparedBroadcast> {
    const youtube = this.client();
    try {
      const broadcastResponse = await youtube.liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'],
        requestBody: {
          snippet: {
            title: input.title,
            description: input.description,
            scheduledStartTime: input.scheduledAt,
          },
          status: {
            privacyStatus: input.privacyStatus,
            selfDeclaredMadeForKids: false,
          },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: true,
            enableDvr: true,
            recordFromStart: true,
            monitorStream: { enableMonitorStream: false },
          },
        },
      });
      const broadcastId = broadcastResponse.data.id;
      if (!broadcastId) throw new PilotYouTubeError('API_ERROR');

      const streamResponse = await youtube.liveStreams.insert({
        part: ['snippet', 'cdn'],
        requestBody: {
          snippet: { title: `${input.title} · entrada` },
          cdn: { frameRate: '30fps', ingestionType: 'rtmp', resolution: '1080p' },
        },
      });
      const streamId = streamResponse.data.id;
      const ingestion = streamResponse.data.cdn?.ingestionInfo;
      const ingestionAddress = ingestion?.rtmpsIngestionAddress ?? ingestion?.ingestionAddress;
      const streamName = ingestion?.streamName;
      if (!streamId || !ingestionAddress || !streamName) throw new PilotYouTubeError('API_ERROR');

      await youtube.liveBroadcasts.bind({
        id: broadcastId,
        streamId,
        part: ['id', 'contentDetails'],
      });
      await youtube.thumbnails.set({
        videoId: broadcastId,
        media: {
          mimeType: 'image/png',
          body: Readable.from(Buffer.from(input.thumbnail)),
        },
      });
      return {
        broadcastId,
        streamId,
        ingestUrl: `${ingestionAddress.replace(/\/$/, '')}/${streamName}`,
        watchUrl: `https://www.youtube.com/watch?v=${broadcastId}`,
      };
    } catch (error) {
      if (error instanceof PilotYouTubeError) throw error;
      throw new PilotYouTubeError('API_ERROR');
    }
  }

  public async health(broadcastId: string, streamId: string): Promise<PilotYouTubeHealth> {
    const youtube = this.client();
    try {
      const [streams, broadcasts] = await Promise.all([
        youtube.liveStreams.list({ id: [streamId], part: ['status'] }),
        youtube.liveBroadcasts.list({ id: [broadcastId], part: ['status'] }),
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

  public async completeBroadcast(broadcastId: string): Promise<void> {
    const youtube = this.client();
    try {
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

function isTokenRecord(value: unknown): value is Record<string, string | number> {
  return typeof value === 'object' && value !== null
    && Object.values(value).every((item) => typeof item === 'string' || typeof item === 'number');
}
