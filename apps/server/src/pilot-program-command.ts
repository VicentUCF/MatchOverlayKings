import type { PilotVideoEncoder } from '@kpl/production-contracts';
import { AUDIO_SIGNAL_FILTER, VIDEO_SIGNAL_FILTER } from './pilot-signal-monitor.js';
import { encoderFilter, encoderInputArguments, encoderOutputArguments } from './pilot-video-encoder.js';

export function pilotProgramCommand(
  executable: string,
  ingestUrl: string | null,
  outputFramesPerSecond: 30 | 60,
  videoEncoding: PilotVideoEncoder,
  preview?: { readonly path: string; readonly seconds: number },
  recordingPath?: string,
) {
  const input = ['-thread_queue_size', '8', '-probesize', '32', '-analyzeduration', '0',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', '1920x1080', '-framerate', String(outputFramesPerSecond), '-i', 'pipe:6',
    '-thread_queue_size', '8', '-probesize', '32', '-analyzeduration', '0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:7'];
  const analysis = `[0:v]split=2[camera][analysis];[analysis]${VIDEO_SIGNAL_FILTER},nullsink`;
  const baseVideo = '[camera][2:v]overlay=0:0:format=auto[composite]';
  const videoFilter = `${analysis};${baseVideo};[composite]${encoderFilter(videoEncoding)}[vout]`;
  const audioFilter = `;[1:a:0]${AUDIO_SIGNAL_FILTER}[aout]`;
  const output = preview
    ? ['-t', String(preview.seconds), '-movflags', '+faststart', '-f', 'mp4', '-n', preview.path]
    : recordingPath
    ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-n', recordingPath]
    : ingestUrl === null
    ? ['-f', 'null', '-']
    : ['-f', 'flv', ingestUrl];
  return {
    executable,
    argv: [
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '1',
      ...encoderInputArguments(videoEncoding),
      ...input,
      '-thread_queue_size', '64', '-probesize', '32', '-fpsprobesize', '0', '-f', 'image2pipe', '-vcodec', 'png',
      '-framerate', `${outputFramesPerSecond}`, '-i', 'pipe:3',
      '-filter_complex', `${videoFilter}${audioFilter}`, '-map', '[vout]', '-map', '[aout]',
      ...encoderOutputArguments(videoEncoding, outputFramesPerSecond),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      ...output,
    ],
  } as const;
}

