import { describe, expect, it } from 'vitest';
import { FfmpegHealthTracker, FfmpegProgressParser } from '../src/index.js';

describe('FFmpeg progress primitives', () => {
  it('emits only complete records across arbitrary CRLF chunks', () => {
    const parser = new FfmpegProgressParser();

    expect(parser.push(new TextEncoder().encode('frame=12\r\nout_time_'))).toEqual([]);
    const records = parser.push(new TextEncoder().encode('us=4000\r\nfps=30.5\r\nspeed=1.2x\r\nprogress=continue\r\n'));

    expect(records).toEqual([{ frame: 12, outTimeUs: 4000, fps: 30.5, speed: 1.2, progress: 'continue' }]);
  });

  it('returns bounded errors for malformed and oversized input', () => {
    const parser = new FfmpegProgressParser();

    expect(() => parser.push(new TextEncoder().encode(
      'frame=1\nout_time_us=NaN\nfps=30\nspeed=1x\nprogress=continue\n',
    )))
      .toThrowError(expect.objectContaining({ code: 'MALFORMED_PROGRESS' }));
    expect(() => parser.push(new Uint8Array(70_000))).toThrowError(
      expect.objectContaining({ code: 'PROGRESS_TOO_LARGE' }),
    );
  });

  it('accepts FFmpeg N/A values and documented negative timestamps', () => {
    const parser = new FfmpegProgressParser();

    const unavailable = parser.push(new TextEncoder().encode(
      'frame=0\nout_time_us=N/A\nfps=0\nspeed=N/A\nprogress=continue\n',
    ));
    const negative = parser.push(new TextEncoder().encode(
      'frame=1\nout_time_us=-100\nfps=1.5\nspeed=0.5x\nprogress=end\n',
    ));

    expect(unavailable[0]).toMatchObject({ outTimeUs: null, speed: null });
    expect(negative[0]).toMatchObject({ outTimeUs: -100, speed: 0.5 });
    expect(parser.hasEnded()).toBe(true);
  });

  it.each([
    ['fractional frame', 'frame=1.5\nout_time_us=1\nfps=1\nspeed=1x\nprogress=continue\n'],
    ['negative frame', 'frame=-1\nout_time_us=1\nfps=1\nspeed=1x\nprogress=continue\n'],
    ['negative fps', 'frame=1\nout_time_us=1\nfps=-1\nspeed=1x\nprogress=continue\n'],
    ['negative speed', 'frame=1\nout_time_us=1\nfps=1\nspeed=-1x\nprogress=continue\n'],
  ])('rejects %s', (_label, input) => {
    const parser = new FfmpegProgressParser();

    expect(() => parser.push(new TextEncoder().encode(input))).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_PROGRESS' }),
    );
  });

  it('enforces line limits in bytes for multibyte input', () => {
    const parser = new FfmpegProgressParser();
    const input = `unknown=${'é'.repeat(2050)}\n`;

    expect(() => parser.push(new TextEncoder().encode(input))).toThrowError(
      expect.objectContaining({ code: 'PROGRESS_TOO_LARGE' }),
    );
  });

  it('parses many complete records without treating a large chunk as one line', () => {
    const parser = new FfmpegProgressParser();
    const record = 'frame=1\nout_time_us=1\nfps=1\nspeed=1x\nprogress=continue\n';

    const records = parser.push(new TextEncoder().encode(record.repeat(2000)));

    expect(records).toHaveLength(2000);
  });

  it.each([
    ['incomplete UTF-8', new Uint8Array([0xc3])],
    ['incomplete line', new TextEncoder().encode('frame=1')],
    ['incomplete record', new TextEncoder().encode('frame=1\n')],
  ])('rejects %s at EOF', (_label, input) => {
    const parser = new FfmpegProgressParser();
    parser.push(input);

    expect(() => parser.finish()).toThrowError(
      expect.objectContaining({ code: 'INCOMPLETE_PROGRESS' }),
    );
  });

  it('rejects empty numeric values instead of coercing them to zero', () => {
    const parser = new FfmpegProgressParser();

    expect(() => parser.push(new TextEncoder().encode(
      'frame=1\nout_time_us=1\nfps=\nspeed=1x\nprogress=continue\n',
    ))).toThrowError(expect.objectContaining({ code: 'MALFORMED_PROGRESS' }));
  });

  it('rejects push after the parser is finished', () => {
    const parser = new FfmpegProgressParser();
    parser.finish();

    expect(() => parser.push(new Uint8Array())).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_PROGRESS' }),
    );
  });

  it('reports awaiting, healthy, stalled, ended, and closed states from monotonic time', () => {
    const tracker = new FfmpegHealthTracker(1000);

    expect(tracker.inspect(0, false)).toEqual({ state: 'awaiting_progress' });
    tracker.observe({ frame: 1, outTimeUs: 100, fps: 30, speed: 1, progress: 'continue' }, 10);
    expect(tracker.inspect(500, false)).toEqual({ state: 'healthy' });
    expect(tracker.inspect(1011, false)).toEqual({ state: 'stalled' });
    tracker.observe({ frame: 2, outTimeUs: 200, fps: 30, speed: 1, progress: 'end' }, 1020);
    expect(tracker.inspect(1020, false)).toEqual({ state: 'ended' });
    expect(tracker.inspect(1020, true)).toEqual({ state: 'closed' });
  });

  it('treats frame advancement with an unavailable timestamp as healthy progress', () => {
    const tracker = new FfmpegHealthTracker(1000);
    tracker.observe({ frame: 1, outTimeUs: null, fps: 1, speed: null, progress: 'continue' }, 10);

    expect(tracker.inspect(20, false)).toEqual({ state: 'healthy' });
  });

  it('does not refresh health for repeated or regressing progress values', () => {
    const tracker = new FfmpegHealthTracker(1000);
    tracker.observe({ frame: 5, outTimeUs: 100, fps: 1, speed: 1, progress: 'continue' }, 10);
    tracker.observe({ frame: 5, outTimeUs: 100, fps: 1, speed: 1, progress: 'continue' }, 900);
    tracker.observe({ frame: 4, outTimeUs: 99, fps: 1, speed: 1, progress: 'continue' }, 950);

    expect(tracker.inspect(1011, false)).toEqual({ state: 'stalled' });
  });

  it('treats advancing timestamps as healthy even when frames are unavailable', () => {
    const tracker = new FfmpegHealthTracker(1000);
    tracker.observe({ frame: 0, outTimeUs: 100, fps: 1, speed: 1, progress: 'continue' }, 10);

    expect(tracker.inspect(20, false)).toEqual({ state: 'healthy' });
  });

  it('tracks monotonic advancement through negative output timestamps', () => {
    // Given
    const tracker = new FfmpegHealthTracker(1000);
    tracker.observe({ frame: 0, outTimeUs: -100, fps: 1, speed: 1, progress: 'continue' }, 10);

    // When
    tracker.observe({ frame: 0, outTimeUs: -50, fps: 1, speed: 1, progress: 'continue' }, 20);

    // Then
    expect(tracker.inspect(30, false)).toEqual({ state: 'healthy' });
  });

  it('keeps terminal states sticky after later progress', () => {
    const tracker = new FfmpegHealthTracker(1000);
    tracker.observe({ frame: 1, outTimeUs: 100, fps: 1, speed: 1, progress: 'end' }, 10);
    tracker.observe({ frame: 2, outTimeUs: null, fps: 1, speed: null, progress: 'continue' }, 20);

    expect(tracker.inspect(20, false)).toEqual({ state: 'ended' });
    expect(tracker.inspect(20, true)).toEqual({ state: 'closed' });
  });

  it('rejects invalid timeouts, invalid time, and a backward monotonic clock', () => {
    expect(() => new FfmpegHealthTracker(Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIMEOUT' }),
    );
    const tracker = new FfmpegHealthTracker(1000);
    expect(() => tracker.inspect(Number.POSITIVE_INFINITY, false)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIME' }),
    );
    tracker.inspect(10, false);
    expect(() => tracker.inspect(9, false)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIME' }),
    );
  });
});
