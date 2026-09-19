import { Readable } from 'node:stream';
import type { youtube_v3 } from 'googleapis';
import { z } from 'zod';
import type { PilotPrivacy } from '@kpl/production-contracts';

// This state is private: ingest credentials must never be included in API responses.
export const YouTubePreparationSchema = z.strictObject({
  operationId: z.uuid(),
  channelId: z.string().nullable().default(null),
  broadcastAttemptAt: z.iso.datetime().nullable().default(null),
  streamAttemptAt: z.iso.datetime().nullable().default(null),
  broadcastMissingSince: z.iso.datetime().nullable().default(null),
  streamMissingSince: z.iso.datetime().nullable().default(null),
  broadcastId: z.string().nullable().default(null),
  streamId: z.string().nullable().default(null),
  ingestUrl: z.string().nullable().default(null),
  framesPerSecond: z.union([z.literal(30), z.literal(60)]),
  ready: z.boolean().default(false),
}).readonly();
export type YouTubePreparation = z.infer<typeof YouTubePreparationSchema>;
export type PreparationCheckpoint = (state: YouTubePreparation) => Promise<void>;
export type YouTubePreparationInput = {
  readonly title: string;
  readonly description: string;
  readonly scheduledAt: string;
  readonly privacyStatus: PilotPrivacy;
  readonly thumbnail: Uint8Array;
};

export class YouTubePreparationError extends Error {}

/** Recover non-idempotent inserts by their durable intent and private remote marker. */
export class YouTubePreparationTransaction {
  public constructor(
    private readonly youtube: youtube_v3.Youtube,
    private state: YouTubePreparation,
    private readonly checkpoint: PreparationCheckpoint,
    private readonly signal?: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}

  private options() {
    this.signal?.throwIfAborted();
    return { timeout: 8_000, retry: false, ...(this.signal ? { signal: this.signal } : {}) };
  }

  private async save(patch: Partial<YouTubePreparation>): Promise<void> {
    const next = YouTubePreparationSchema.parse({ ...this.state, ...patch });
    await this.checkpoint(next);
    this.state = next;
  }

  private marker(): string { return `[KPL:${this.state.operationId}]`; }

  private async verifyChannel(): Promise<void> {
    const response = await this.youtube.channels.list({ mine: true, part: ['id'], maxResults: 2 }, this.options());
    const channels = response.data.items ?? [];
    const channelId = channels.length === 1 ? channels[0]?.id : null;
    if (!channelId || (this.state.channelId !== null && this.state.channelId !== channelId)) {
      throw new YouTubePreparationError('Conecta el mismo canal de YouTube con el que se inició esta preparación.');
    }
    if (this.state.channelId === null) await this.save({ channelId });
  }

  /** Read-only remote reconciliation. Checkpoints only change private local storage. */
  public async inspect(): Promise<YouTubePreparation> {
    await this.verifyChannel();
    if (this.state.broadcastAttemptAt !== null && this.state.broadcastId === null) {
      const matches = await this.findMarked('broadcast');
      const match = this.unique(matches);
      if (match?.id) await this.save({ broadcastId: match.id, broadcastMissingSince: null });
    }
    if (this.state.streamAttemptAt !== null && this.state.streamId === null) {
      const matches = await this.findMarked('stream');
      const match = this.unique(matches) as youtube_v3.Schema$LiveStream | null;
      if (match?.id) await this.save({ streamId: match.id, ingestUrl: ingestUrl(match), streamMissingSince: null });
    }
    return this.state;
  }

  public async prepare(input: YouTubePreparationInput): Promise<YouTubePreparation> {
    await this.inspect();
    if (this.state.broadcastId === null) {
      if (this.state.broadcastAttemptAt !== null) throw new YouTubePreparationError('YouTube aún no confirma el broadcast solicitado. Reintenta Recuperar preparación o Finalizar sesión; no se creará otro directo.');
      await this.save({ broadcastAttemptAt: new Date(this.now()).toISOString() });
      const response = await this.youtube.liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'], requestBody: {
          snippet: {
            title: input.title,
            description: `${input.description.slice(0, 4_940)}\n\n${this.marker()}`,
            scheduledStartTime: input.scheduledAt,
          },
          status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
          contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true,
            recordFromStart: true, monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 } },
        },
      }, this.options());
      if (!response.data.id) throw new YouTubePreparationError('YouTube no confirmó el identificador del broadcast. Recupera esta preparación.');
      await this.save({ broadcastId: response.data.id });
    }
    const broadcastId = this.state.broadcastId!;
    const broadcast = (await this.youtube.liveBroadcasts.list({ id: [broadcastId], part: ['status', 'contentDetails'] }, this.options())).data.items?.[0];
    if (!broadcast || ['complete', 'revoked'].includes(broadcast.status?.lifeCycleStatus ?? '')) {
      throw new YouTubePreparationError('YouTube ya ha cerrado o retirado este broadcast. Finaliza esta sesión antes de preparar otra.');
    }
    if (!['created', 'ready'].includes(broadcast.status?.lifeCycleStatus ?? '')) {
      throw new YouTubePreparationError('El broadcast cambió fuera de esta preparación. Comprueba su estado y finaliza esta sesión si necesitas cerrarlo.');
    }
    if (this.state.streamId === null) {
      if (this.state.streamAttemptAt !== null) throw new YouTubePreparationError('YouTube aún no confirma la entrada solicitada. Reintenta la recuperación; no se creará otra entrada.');
      await this.save({ streamAttemptAt: new Date(this.now()).toISOString() });
      const response = await this.youtube.liveStreams.insert({
        part: ['snippet', 'cdn'], requestBody: {
          snippet: { title: `${input.title.slice(0, 90)} · entrada`, description: this.marker() },
          cdn: { frameRate: this.state.framesPerSecond === 60 ? '60fps' : '30fps', ingestionType: 'rtmp', resolution: '1080p' },
        },
      }, this.options());
      if (!response.data.id) throw new YouTubePreparationError('YouTube no confirmó la entrada. Recupera esta misma preparación.');
      await this.save({ streamId: response.data.id, ingestUrl: ingestUrl(response.data) });
    }
    const streamId = this.state.streamId!;
    if (broadcast.contentDetails?.boundStreamId && broadcast.contentDetails.boundStreamId !== streamId) {
      throw new YouTubePreparationError('El broadcast está vinculado a otra entrada. No se cambiará automáticamente; revisa o finaliza esta sesión.');
    }
    if (this.state.ingestUrl === null) {
      const stream = (await this.youtube.liveStreams.list({ id: [streamId], part: ['cdn'] }, this.options())).data.items?.[0];
      const url = stream ? ingestUrl(stream) : null;
      if (url === null) throw new YouTubePreparationError('La entrada protegida aún no está disponible. Reintenta la recuperación.');
      await this.save({ ingestUrl: url });
    }
    await this.youtube.liveBroadcasts.bind({ id: broadcastId, streamId, part: ['id', 'contentDetails'] }, this.options());
    await this.youtube.thumbnails.set({ videoId: broadcastId,
      media: { mimeType: 'image/png', body: Readable.from(Buffer.from(input.thumbnail)) } }, this.options());
    // Use videos.update so a late recovery preserves the original match schedule.
    const video = (await this.youtube.videos.list({ id: [broadcastId], part: ['snippet', 'status'] }, this.options())).data.items?.[0];
    if (!video?.snippet?.categoryId) throw new YouTubePreparationError('YouTube todavía no permite finalizar los metadatos. Reintenta Recuperar preparación.');
    await this.youtube.videos.update({ part: ['snippet', 'status'], requestBody: {
      id: broadcastId,
      snippet: { ...mutable(video.snippet, ['categoryId', 'tags', 'defaultLanguage', 'defaultAudioLanguage']), title: input.title, description: input.description },
      status: { ...mutable(video.status ?? {}, ['embeddable', 'license', 'publicStatsViewable', 'containsSyntheticMedia']),
        privacyStatus: input.privacyStatus, selfDeclaredMadeForKids: false },
    } }, this.options());
    await this.save({ ready: true });
    return this.state;
  }

  public async cancel(): Promise<void> {
    await this.inspect();
    // A lost insert response is not evidence that nothing was created. Two full
    // absence checks, separated in time, allow an explicit operator cancellation.
    const unresolvedBroadcast = this.state.broadcastId === null && this.state.broadcastAttemptAt !== null;
    const unresolvedStream = this.state.streamId === null && this.state.streamAttemptAt !== null;
    if (unresolvedBroadcast) await this.confirmAbsent('broadcast');
    if (unresolvedStream) await this.confirmAbsent('stream');
    if (this.state.broadcastId !== null) {
      const id = this.state.broadcastId;
      const broadcast = (await this.youtube.liveBroadcasts.list({ id: [id], part: ['status'] }, this.options())).data.items?.[0];
      if (broadcast && ['created', 'ready'].includes(broadcast.status?.lifeCycleStatus ?? '')) {
        await this.youtube.liveBroadcasts.delete({ id }, this.options());
      } else if (broadcast && !['complete', 'revoked'].includes(broadcast.status?.lifeCycleStatus ?? '')) {
        await this.youtube.liveBroadcasts.transition({ id, broadcastStatus: 'complete', part: ['id', 'status'] }, this.options());
      }
    }
    if (this.state.streamId !== null) {
      const id = this.state.streamId;
      const stream = (await this.youtube.liveStreams.list({ id: [id], part: ['id'] }, this.options())).data.items?.[0];
      if (stream) await this.youtube.liveStreams.delete({ id }, this.options());
    }
  }

  private async confirmAbsent(kind: 'broadcast' | 'stream'): Promise<void> {
    const attemptAt = kind === 'broadcast' ? this.state.broadcastAttemptAt : this.state.streamAttemptAt;
    const missingSince = kind === 'broadcast' ? this.state.broadcastMissingSince : this.state.streamMissingSince;
    if (missingSince === null) await this.save(kind === 'broadcast'
      ? { broadcastMissingSince: new Date(this.now()).toISOString() } : { streamMissingSince: new Date(this.now()).toISOString() });
    if (missingSince === null || this.now() - Date.parse(missingSince) < 5_000 || this.now() - Date.parse(attemptAt!) < 60_000) {
      throw new YouTubePreparationError('YouTube no muestra todavía el recurso solicitado. Espera un minuto y vuelve a Finalizar sesión para confirmar su ausencia.');
    }
  }

  private unique(matches: readonly (youtube_v3.Schema$LiveBroadcast | youtube_v3.Schema$LiveStream)[]) {
    if (matches.length > 1) throw new YouTubePreparationError('Hay varios recursos con la misma referencia de recuperación. Se conserva el bloqueo para no modificar un destino ambiguo.');
    return matches[0] ?? null;
  }

  private async findMarked(kind: 'broadcast' | 'stream') {
    const matches: (youtube_v3.Schema$LiveBroadcast | youtube_v3.Schema$LiveStream)[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const params = { mine: true, maxResults: 50, part: ['snippet', ...(kind === 'stream' ? ['cdn'] : [])], ...(pageToken ? { pageToken } : {}) };
      const response = kind === 'broadcast'
        ? await this.youtube.liveBroadcasts.list({ ...params, broadcastType: 'all' }, this.options())
        : await this.youtube.liveStreams.list(params, this.options());
      matches.push(...(response.data.items ?? []).filter((item) => item.snippet?.channelId === this.state.channelId
        && item.snippet?.description?.split(/\r?\n/).includes(this.marker())));
      const next = response.data.nextPageToken;
      if (!next) return matches;
      if (seen.has(next)) break;
      seen.add(next);
      pageToken = next;
    }
    throw new YouTubePreparationError('No se pudo completar la búsqueda de recursos de YouTube. Conservamos la preparación; vuelve a intentar.');
  }
}

function ingestUrl(stream: youtube_v3.Schema$LiveStream): string | null {
  const ingestion = stream.cdn?.ingestionInfo;
  const address = ingestion?.rtmpsIngestionAddress ?? ingestion?.ingestionAddress;
  return address && ingestion?.streamName ? `${address.replace(/\/$/, '')}/${ingestion.streamName}` : null;
}

function mutable<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.filter((key) => value[key] != null).map((key) => [key, value[key]])) as Partial<T>;
}
