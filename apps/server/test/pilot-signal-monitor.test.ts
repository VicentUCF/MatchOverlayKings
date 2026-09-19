import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AUDIO_SIGNAL_FILTER, VIDEO_SIGNAL_FILTER, PilotSignalMonitor } from '../src/pilot-signal-monitor.js';

describe('signal monitoring', () => {
  it('detects and clears black, frozen and silent segments using real FFmpeg filters', async () => {
    const monitor = new PilotSignalMonitor({ fps: 30, audioExpected: true, remoteOutput: false });
    const seen = new Set<string>();
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=9[b];testsrc2=s=320x180:r=30:d=2[m];[b][m]concat=n=2:v=1:a=0',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=9[s];sine=frequency=1000:duration=2[n];[s][n]concat=n=2:v=0:a=1',
      '-filter_complex', `[0:v]${VIDEO_SIGNAL_FILTER}[v];[1:a]${AUDIO_SIGNAL_FILTER}[a]`,
      '-map', '[v]', '-map', '[a]', '-threads', '1', '-f', 'null', '-'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stderr!.on('data', (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk}`.slice(-2_000); });
    for (const [index, receive] of [[4, (line: string) => monitor.video(line)], [5, (line: string) => monitor.audio(line)]] as const) {
      let pending = '';
      const pipe = (child.stdio as unknown as readonly Readable[])[index]!;
      pipe.on('data', (chunk: Buffer) => {
        const lines = `${pending}${chunk.toString()}`.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          receive(`${line}\n`);
          for (const issue of monitor.snapshot().issues) seen.add(issue.code);
        }
      });
    }
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FFmpeg signal probe timed out')); }, 10_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (code) => { clearTimeout(timeout); resolve(code); });
    });
    expect(code, diagnostic).toBe(0);
    expect([...seen]).toEqual(expect.arrayContaining(['black_video', 'frozen_video', 'silent_audio']));
    expect(monitor.snapshot().issues).toEqual([]);
  }, 15_000);

  it('ignores intentional silence, accepts split metadata and never exposes arbitrary pipe contents', () => {
    const monitor = new PilotSignalMonitor({ fps: 30, audioExpected: false, remoteOutput: false });
    monitor.audio('lavfi.silence_start=0\n');
    monitor.video('frame:0 pts:0 pts_time:0\nlavfi.blackframe.p');
    monitor.video('black=100\nframe:6 pts:6 pts_time:3\nlavfi.blackframe.pblack=100\nsecret=rtmps://key\n');
    expect(monitor.snapshot().issues.map(({ code }) => code)).toEqual(['black_video']);
    expect(JSON.stringify(monitor.snapshot())).not.toContain('rtmps');
    monitor.video('frame:7 pts:7 pts_time:3.5\nlavfi.blackframe.pblack=0\n');
    expect(monitor.snapshot().issues).toEqual([]);
  });

  it('uses recent deltas and sustained thresholds for degraded output, then clears recovered metrics', () => {
    let now = Date.parse('2026-09-19T12:00:00Z');
    const monitor = new PilotSignalMonitor({ fps: 30, audioExpected: true, remoteOutput: true }, () => now);
    for (let second = 0; second <= 20; second++) {
      monitor.video(`frame:${second} pts:${second} pts_time:${second}\nlavfi.blackframe.pblack=0\n`);
      monitor.progress({ frame: String(second * 15), out_time_us: String(second * 500_000), total_size: String(second * 100_000), drop_frames: String(second * 2) });
      if (second === 10) expect(monitor.snapshot().issues).toEqual([]);
      now += 1_000;
    }
    expect(monitor.snapshot()).toMatchObject({ measuredFramesPerSecond: 15, measuredSpeed: 0.5, measuredBitrateKbps: 800 });
    expect(monitor.snapshot().issues.map(({ code }) => code)).toEqual(['low_fps', 'slow_encoder', 'dropped_frames', 'low_bitrate']);
    for (let second = 1; second <= 12; second++) {
      monitor.video(`frame:${second + 20} pts:0 pts_time:${second + 20}\nlavfi.blackframe.pblack=0\n`);
      monitor.progress({ frame: String(300 + second * 30), out_time_us: String(10_000_000 + second * 1_000_000), total_size: String(2_000_000 + second * 800_000), drop_frames: '40' });
      now += 1_000;
    }
    expect(monitor.snapshot().issues).toEqual([]);
  });

  it('warns when video analysis disappears and does not invent bitrate for local null output', () => {
    let now = 0;
    const monitor = new PilotSignalMonitor({ fps: 30, audioExpected: false, remoteOutput: false }, () => now);
    for (let second = 0; second <= 16; second++) {
      now = second * 1_000;
      monitor.progress({ frame: String(second * 30), out_time_us: String(second * 1_000_000), total_size: 'N/A', drop_frames: '0' });
    }
    expect(monitor.snapshot().issues.map(({ code }) => code)).toEqual(['video_missing']);
    expect(monitor.snapshot().measuredBitrateKbps).toBeNull();
  });
});
