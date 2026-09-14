/* global console, process */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const ffmpeg = process.env.KPL_PILOT_FFMPEG_PATH ?? '/bin/ffmpeg';
const streamCount = 3;
const durationSeconds = 15;
const minimumHeadroom = 1.15;

const startedAt = performance.now();
const results = await Promise.all(Array.from({ length: streamCount }, (_, index) => runEncoder(index + 1)));
const wallSeconds = (performance.now() - startedAt) / 1_000;
const minimumSpeed = Math.min(...results.map(({ speed }) => speed));
const passed = results.every(({ exitCode }) => exitCode === 0) && minimumSpeed >= minimumHeadroom;

console.log(JSON.stringify({
  test: '3 salidas independientes 1080p30 H.264 + AAC',
  ffmpeg,
  durationSeconds,
  wallSeconds: rounded(wallSeconds),
  minimumRequiredSpeed: minimumHeadroom,
  minimumMeasuredSpeed: rounded(minimumSpeed),
  streams: results,
  passed,
  interpretation: passed
    ? 'El PC conserva al menos un 15 % de margen de codificación sintética para tres salidas.'
    : 'El PC no conserva el margen mínimo para tres salidas por CPU con esta configuración.',
  caveat: 'Esta prueba no valida cámaras, overlays, audio físico, red ni la recepción de YouTube.',
}, null, 2));

process.exitCode = passed ? 0 : 1;

function runEncoder(streamNumber) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-stats_period', '1',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(durationSeconds), '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-f', 'null', '/dev/null',
    ], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      const speeds = [...stdout.matchAll(/^speed=(.+?)x\s*$/gm)]
        .map((match) => Number.parseFloat(match[1]))
        .filter(Number.isFinite);
      resolve({
        stream: streamNumber,
        exitCode,
        speed: rounded(speeds.at(-1) ?? 0),
        diagnostic: exitCode === 0 ? null : stderr.trim().split(/\r?\n/).at(-1) ?? 'FFmpeg terminó con error.',
      });
    });
  });
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}
