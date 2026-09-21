import type { PilotSignalHealth, PilotSignalIssueCode } from '@kpl/production-contracts';

// Select samples without the fps filter's lookahead: on a split raw A/V input that
// lookahead can block VAAPI while the encoder waits for the next program frame.
export const VIDEO_SIGNAL_FILTER = "select='isnan(prev_selected_t)+gte(t-prev_selected_t,0.5)',scale=320:180,freezedetect=n=-60dB:d=8,blackframe=amount=0:threshold=32,metadata=mode=print:file='pipe\\:4':direct=1";
export const AUDIO_SIGNAL_FILTER = "silencedetect=n=-50dB:d=8,ametadata=mode=print:file='pipe\\:5':direct=1";

const MESSAGES: Record<PilotSignalIssueCode, string> = {
  black_video: 'La cámara muestra una imagen casi negra durante al menos 3 s. Comprueba iluminación, lente y fuente.',
  frozen_video: 'La imagen apenas cambia durante al menos 8 s. Comprueba si la cámara está congelada o la escena está inmóvil.',
  silent_audio: 'El micrófono permanece en silencio durante al menos 8 s. Comprueba el audio si debería oírse el partido.',
  video_missing: 'No llegan muestras de vídeo para comprobar la cámara. Revisa la señal y el encoder.',
  low_fps: 'La salida produce menos del 80 % de los fotogramas previstos. Revisa la fuente y la carga del PC.',
  slow_encoder: 'La codificación no mantiene 0,95× en tiempo real. Revisa CPU/GPU y el perfil de vídeo.',
  dropped_frames: 'Se pierde más del 1 % de los fotogramas de salida. Revisa la fuente y la carga del encoder.',
  low_bitrate: 'El bitrate reciente es inferior al 30 % del objetivo. Comprueba la calidad y la salud del destino.',
};
type Sample = { at: number; frame: number; mediaUs: number | null; bytes: number | null; dropped: number };

export class PilotSignalMonitor {
  private readonly startedAt: number;
  private videoBuffer = '';
  private audioBuffer = '';
  private videoPts: number | null = null;
  private blackSince: number | null = null;
  private lastVideoAt: number | null = null;
  private readonly issues = new Map<PilotSignalIssueCode, { code: PilotSignalIssueCode; since: string; message: string }>();
  private readonly candidates = new Map<PilotSignalIssueCode, number>();
  private samples: Sample[] = [];
  private metrics: Pick<PilotSignalHealth, 'measuredFramesPerSecond' | 'measuredSpeed' | 'measuredBitrateKbps' | 'droppedFrameRatio'> = {
    measuredFramesPerSecond: null, measuredSpeed: null, measuredBitrateKbps: null, droppedFrameRatio: null,
  };

  public constructor(private readonly options: { fps: 30 | 60; audioExpected: boolean; remoteOutput: boolean }, private readonly now = Date.now) {
    this.startedAt = now();
  }

  public video(chunk: string): void {
    const lines = this.lines(this.videoBuffer, chunk);
    this.videoBuffer = lines.pending;
    for (const line of lines.lines) {
      const pts = /\bpts_time:([-\d.]+)/.exec(line)?.[1];
      if (pts !== undefined) this.videoPts = finite(pts);
      const [key, raw] = line.split('=', 2);
      const value = finite(raw);
      if (value === null) continue;
      if (key === 'lavfi.blackframe.pblack' && this.videoPts !== null) {
        this.lastVideoAt = this.now();
        if (value >= 98) {
          if (this.blackSince === null || this.videoPts < this.blackSince) this.blackSince = this.videoPts;
          this.set('black_video', this.videoPts - this.blackSince >= 3);
        } else { this.blackSince = null; this.set('black_video', false); }
      }
      if (key === 'lavfi.freezedetect.freeze_start') this.set('frozen_video', true);
      if (key === 'lavfi.freezedetect.freeze_end') this.set('frozen_video', false);
    }
  }

  public audio(chunk: string): void {
    if (!this.options.audioExpected) return;
    const lines = this.lines(this.audioBuffer, chunk);
    this.audioBuffer = lines.pending;
    for (const line of lines.lines) {
      const [key, raw] = line.split('=', 2);
      if (finite(raw) === null) continue;
      if (key === 'lavfi.silence_start') this.set('silent_audio', true);
      if (key === 'lavfi.silence_end') this.set('silent_audio', false);
    }
  }

  public progress(progress: Readonly<Record<string, string>>): void {
    const now = this.now();
    const current: Sample = { at: now, frame: finite(progress.frame) ?? 0, mediaUs: finite(progress.out_time_us),
      bytes: finite(progress.total_size), dropped: finite(progress.drop_frames) ?? 0 };
    if (current.frame < (this.samples.at(-1)?.frame ?? 0)) this.samples = [];
    this.samples.push(current);
    // Retain one anchor at least five seconds old; never depend on lifetime averages.
    while (this.samples.length > 2 && this.samples[1]!.at <= now - 5_000) this.samples.shift();
    if (this.samples.length > 120) this.samples.splice(0, this.samples.length - 120);
    const first = this.samples[0]!;
    const elapsed = (now - first.at) / 1_000;
    if (elapsed < 5 || now - this.startedAt < 10_000) return;
    const frames = Math.max(0, current.frame - first.frame);
    const dropped = Math.max(0, current.dropped - first.dropped);
    this.metrics = {
      measuredFramesPerSecond: frames / elapsed,
      measuredSpeed: current.mediaUs !== null && first.mediaUs !== null ? Math.max(0, (current.mediaUs - first.mediaUs) / 1_000_000 / elapsed) : null,
      measuredBitrateKbps: current.bytes !== null && first.bytes !== null ? Math.max(0, (current.bytes - first.bytes) * 8 / 1_000 / elapsed) : null,
      droppedFrameRatio: frames + dropped > 0 ? dropped / (frames + dropped) : 0,
    };
    this.sustained('low_fps', this.metrics.measuredFramesPerSecond! < this.options.fps * 0.8);
    this.sustained('slow_encoder', this.metrics.measuredSpeed !== null && this.metrics.measuredSpeed < 0.95);
    this.sustained('dropped_frames', this.metrics.droppedFrameRatio! > 0.01);
    this.sustained('low_bitrate', this.options.remoteOutput && this.metrics.measuredBitrateKbps !== null
      && this.metrics.measuredBitrateKbps < (this.options.fps === 60 ? 9_000 : 6_000) * 0.3);
  }

  public snapshot(): PilotSignalHealth {
    const now = this.now();
    this.set('video_missing', now - this.startedAt >= 10_000 && (this.lastVideoAt === null || now - this.lastVideoAt >= 5_000));
    return { sampledAt: new Date(now).toISOString(), checking: now - this.startedAt < 10_000, lastVideoSampleAt: this.lastVideoAt === null ? null : new Date(this.lastVideoAt).toISOString(),
      audioExpected: this.options.audioExpected, ...this.metrics, issues: [...this.issues.values()] };
  }

  private sustained(code: PilotSignalIssueCode, bad: boolean): void {
    if (!bad) { this.candidates.delete(code); this.set(code, false); return; }
    const first = this.candidates.get(code) ?? this.now();
    this.candidates.set(code, first);
    if (this.now() - first >= 5_000) this.set(code, true);
  }

  private set(code: PilotSignalIssueCode, active: boolean): void {
    if (!active) this.issues.delete(code);
    else if (!this.issues.has(code)) this.issues.set(code, { code, since: new Date(this.now()).toISOString(), message: MESSAGES[code] });
  }

  private lines(pending: string, chunk: string) {
    // Only known numeric metadata is accepted; unbounded or secret-bearing text is discarded.
    const lines = `${pending}${chunk}`.split(/\r?\n/);
    const tail = lines.pop() ?? '';
    return { lines: lines.filter((line) => line.length <= 300), pending: tail.length <= 300 ? tail : '' };
  }
}

function finite(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
