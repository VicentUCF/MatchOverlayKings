const MAX_LINE_BYTES = 4096;
const MAX_FIELDS_PER_RECORD = 64;

export type FfmpegProgressRecord = {
  readonly frame: number;
  readonly outTimeUs: number | null;
  readonly fps: number;
  readonly speed: number | null;
  readonly progress: 'continue' | 'end';
};

export type FfmpegProgressErrorCode =
  | 'INCOMPLETE_PROGRESS'
  | 'MALFORMED_PROGRESS'
  | 'PROGRESS_TOO_LARGE';

const progressErrorMessages = {
  INCOMPLETE_PROGRESS: 'Incomplete FFmpeg progress',
  MALFORMED_PROGRESS: 'Malformed FFmpeg progress',
  PROGRESS_TOO_LARGE: 'FFmpeg progress exceeds limit',
} as const satisfies Record<FfmpegProgressErrorCode, string>;

export class FfmpegProgressError extends Error {
  public constructor(public readonly code: FfmpegProgressErrorCode) {
    super(progressErrorMessages[code]);
    this.name = 'FfmpegProgressError';
  }
}

function parseFrame(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseOutTime(value: string | undefined): number | null | undefined {
  if (value === 'N/A') return null;
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseNonnegative(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseSpeed(value: string | undefined): number | null | undefined {
  if (value === 'N/A') return null;
  if (value === undefined || !value.endsWith('x')) return undefined;
  return parseNonnegative(value.slice(0, -1)) ?? undefined;
}

export class FfmpegProgressParser {
  private lineBytes: number[] = [];
  private fields = new Map<string, string>();
  private fieldCount = 0;
  private ended = false;
  private finished = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  public push(chunk: Uint8Array): readonly FfmpegProgressRecord[] {
    if (this.finished) throw new FfmpegProgressError('MALFORMED_PROGRESS');
    const records: FfmpegProgressRecord[] = [];
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const record = this.processLine();
        if (record !== null) records.push(record);
      } else {
        if (this.lineBytes.length >= MAX_LINE_BYTES) {
          throw new FfmpegProgressError('PROGRESS_TOO_LARGE');
        }
        this.lineBytes.push(byte);
      }
    }
    return records;
  }

  public finish(): void {
    if (this.lineBytes.length > 0) {
      try {
        this.decoder.decode(Uint8Array.from(this.lineBytes));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      throw new FfmpegProgressError('INCOMPLETE_PROGRESS');
    }
    if (this.fieldCount > 0) throw new FfmpegProgressError('INCOMPLETE_PROGRESS');
    this.finished = true;
  }

  public hasEnded(): boolean {
    return this.ended;
  }

  private processLine(): FfmpegProgressRecord | null {
    let bytes = Uint8Array.from(this.lineBytes);
    this.lineBytes = [];
    if (bytes.at(-1) === 0x0d) bytes = bytes.slice(0, -1);
    let line: string;
    try {
      line = this.decoder.decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) throw new FfmpegProgressError('MALFORMED_PROGRESS');
      throw error;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) throw new FfmpegProgressError('MALFORMED_PROGRESS');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'progress') return this.completeRecord(value);
    this.fieldCount += 1;
    if (this.fieldCount > MAX_FIELDS_PER_RECORD) {
      throw new FfmpegProgressError('PROGRESS_TOO_LARGE');
    }
    if (key === 'frame' || key === 'out_time_us' || key === 'fps' || key === 'speed') {
      this.fields.set(key, value);
    }
    return null;
  }

  private completeRecord(marker: string): FfmpegProgressRecord {
    const frame = parseFrame(this.fields.get('frame'));
    const outTimeUs = parseOutTime(this.fields.get('out_time_us'));
    const fps = parseNonnegative(this.fields.get('fps'));
    const speed = parseSpeed(this.fields.get('speed'));
    if ((marker !== 'continue' && marker !== 'end') || frame === null
      || outTimeUs === undefined || fps === null || speed === undefined) {
      throw new FfmpegProgressError('MALFORMED_PROGRESS');
    }
    this.fields = new Map();
    this.fieldCount = 0;
    if (marker === 'end') this.ended = true;
    return { frame, outTimeUs, fps, speed, progress: marker };
  }
}
