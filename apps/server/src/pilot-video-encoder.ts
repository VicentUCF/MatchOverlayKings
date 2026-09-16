import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import type { PilotVideoEncoder } from '@kpl/production-contracts';

export const CPU_ENCODER: PilotVideoEncoder = {
  name: 'libx264', label: 'CPU (x264)', hardware: false, device: null, frameRates: [30, 60],
};

// Do not pass application secrets to FFmpeg. GPU loaders and Windows processes
// still need these OS variables, both during detection and during streaming.
export function ffmpegEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C' };
  for (const key of ['PATH', 'LD_LIBRARY_PATH', 'LIBVA_DRIVERS_PATH', 'LIBVA_DRIVER_NAME',
    'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

type ProbeResult = { readonly ok: boolean; readonly stdout: string };
type Probe = (executable: string, argv: readonly string[]) => Promise<ProbeResult>;

const runProbe: Probe = (executable, argv) => new Promise((resolve) => {
  execFile(executable, [...argv], {
    encoding: 'utf8', timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    env: ffmpegEnvironment(), windowsHide: true,
  }, (error, stdout) => resolve({ ok: error === null, stdout }));
});

export function encoderInputArguments(encoder: PilotVideoEncoder): string[] {
  return encoder.name === 'h264_vaapi' && encoder.device
    ? ['-vaapi_device', encoder.device] : [];
}

export function encoderFilter(encoder: PilotVideoEncoder): string {
  return encoder.name === 'h264_vaapi' ? 'format=nv12,hwupload' : 'format=yuv420p';
}

// Shared by the real stream and the probe: listing an encoder in FFmpeg is not
// evidence that its driver, device permissions or requested profile work.
export function encoderOutputArguments(encoder: PilotVideoEncoder, fps: 30 | 60): string[] {
  const bitrate = fps === 60 ? 9_000 : 6_000;
  const common = ['-c:v', encoder.name, '-profile:v', 'high',
    '-r', String(fps), '-fps_mode', 'cfr', '-g', String(fps * 2), '-bf', '0',
    '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`];
  switch (encoder.name) {
    case 'h264_nvenc':
      return [...common, '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-forced-idr', '1'];
    case 'h264_amf':
      return [...common, '-usage', 'lowlatency', '-quality', 'balanced', '-rc', 'cbr'];
    case 'h264_vaapi':
      return [...common, '-rc_mode', 'CBR'];
    case 'h264_qsv':
      return [...common, '-preset', 'veryfast', '-look_ahead', '0', '-minrate', `${bitrate}k`];
    case 'libx264':
      return [...common, '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-level:v', fps === 60 ? '4.2' : '4.1', '-minrate', `${bitrate}k`,
        '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-keyint_min', String(fps * 2), '-sc_threshold', '0'];
  }
}

export async function detectVideoEncoders(executable: string, options: {
  readonly probe?: Probe;
  readonly platform?: NodeJS.Platform;
  readonly renderDevices?: readonly string[];
} = {}): Promise<readonly PilotVideoEncoder[]> {
  const probe = options.probe ?? runProbe;
  const listing = await probe(executable, ['-hide_banner', '-encoders']);
  if (!listing.ok) return [CPU_ENCODER];
  const platform = options.platform ?? process.platform;
  const candidates: PilotVideoEncoder[] = [
    { name: 'h264_nvenc', label: 'GPU NVIDIA (NVENC)', hardware: true, device: null, frameRates: [] },
  ];
  if (platform === 'win32') {
    candidates.push(
      { name: 'h264_amf', label: 'GPU AMD (AMF)', hardware: true, device: null, frameRates: [] },
      { name: 'h264_qsv', label: 'GPU Intel (Quick Sync)', hardware: true, device: null, frameRates: [] },
    );
  }
  if (platform === 'linux') {
    const devices = options.renderDevices ?? await readdir('/dev/dri')
      .then((names) => names.filter((name) => /^renderD\d+$/.test(name)).sort().map((name) => `/dev/dri/${name}`))
      .catch(() => []);
    for (const device of devices) {
      candidates.push({ name: 'h264_vaapi', label: `GPU (VAAPI · ${device.split('/').at(-1)})`,
        hardware: true, device, frameRates: [] });
    }
  }
  const available: PilotVideoEncoder[] = [];
  for (const candidate of candidates) {
    if (!new RegExp(`\\b${candidate.name}\\b`).test(listing.stdout)) continue;
    const frameRates: Array<30 | 60> = [];
    for (const fps of [30, 60] as const) {
      const result = await probe(executable, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', ...encoderInputArguments(candidate),
        '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=${fps}`,
        '-vf', encoderFilter(candidate), ...encoderOutputArguments(candidate, fps),
        '-frames:v', '3', '-an', '-f', 'null', '-',
      ]);
      if (result.ok) frameRates.push(fps);
    }
    if (frameRates.length > 0) available.push({ ...candidate, frameRates });
  }
  return [...available, CPU_ENCODER];
}

export function encoderKey(encoder: PilotVideoEncoder): string {
  return `${encoder.name}:${encoder.device ?? ''}`;
}

export function selectVideoEncoder(encoders: readonly PilotVideoEncoder[], fps: 30 | 60,
  rejected: ReadonlySet<string>): PilotVideoEncoder {
  return encoders.find((encoder) => encoder.frameRates.includes(fps) && !rejected.has(encoderKey(encoder))) ?? CPU_ENCODER;
}

export function isHardwareEncoderFailure(diagnostic: string): boolean {
  return /(?:nvenc|cuda|cuinit|cudevice|libnvidia|amf|vaapi|vaInitialize|vaCreate|mfx|qsv|hwupload|hardware device|device (?:lost|failed)|Error (?:while )?opening encoder|Error initializing output stream)/i.test(diagnostic);
}
