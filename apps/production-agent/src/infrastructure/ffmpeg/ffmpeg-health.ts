import type { FfmpegProgressRecord } from './ffmpeg-progress.js';

export type FfmpegHealth =
  | { readonly state: 'awaiting_progress' }
  | { readonly state: 'healthy' }
  | { readonly state: 'stalled' }
  | { readonly state: 'ended' }
  | { readonly state: 'closed' };

export type FfmpegHealthErrorCode = 'INVALID_TIME' | 'INVALID_TIMEOUT';

export class FfmpegHealthError extends Error {
  public constructor(public readonly code: FfmpegHealthErrorCode) {
    super(code === 'INVALID_TIME' ? 'Invalid monotonic time' : 'Invalid health timeout');
    this.name = 'FfmpegHealthError';
  }
}

export class FfmpegHealthTracker {
  private latestFrame = 0;
  private latestOutTimeUs: number | null = null;
  private lastAdvanceMs: number | null = null;
  private lastNowMs: number | null = null;
  private ended = false;

  public constructor(private readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new FfmpegHealthError('INVALID_TIMEOUT');
    }
  }

  public observe(record: FfmpegProgressRecord, nowMs: number): void {
    this.acceptTime(nowMs);
    const frameAdvanced = record.frame > this.latestFrame;
    const outTimeAdvanced = record.outTimeUs !== null
      && (this.latestOutTimeUs === null || record.outTimeUs > this.latestOutTimeUs);
    if (frameAdvanced) this.latestFrame = record.frame;
    if (outTimeAdvanced) this.latestOutTimeUs = record.outTimeUs;
    if (frameAdvanced || outTimeAdvanced) {
      this.lastAdvanceMs = nowMs;
    }
    if (record.progress === 'end') this.ended = true;
  }

  public inspect(nowMs: number, closed: boolean): FfmpegHealth {
    this.acceptTime(nowMs);
    if (closed) return { state: 'closed' };
    if (this.ended) return { state: 'ended' };
    if (this.lastAdvanceMs === null) return { state: 'awaiting_progress' };
    return nowMs - this.lastAdvanceMs <= this.timeoutMs
      ? { state: 'healthy' }
      : { state: 'stalled' };
  }

  private acceptTime(nowMs: number): void {
    if (!Number.isFinite(nowMs) || (this.lastNowMs !== null && nowMs < this.lastNowMs)) {
      throw new FfmpegHealthError('INVALID_TIME');
    }
    this.lastNowMs = nowMs;
  }
}
