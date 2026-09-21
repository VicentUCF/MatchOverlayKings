import { describe, expect, it, vi } from 'vitest';
import { consumeProductionEvents, parseProductionEventBlock } from './production-events.js';

describe('production event stream', () => {
  it('rejects heartbeats and malformed invalidations', () => {
    expect(parseProductionEventBlock(': keepalive')).toBeNull();
    expect(parseProductionEventBlock('event: invalidate\ndata: {"scope":"secret","version":1,"occurredAt":"now"}')).toBeNull();
  });

  it('parses invalidations split across stream chunks', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: invalidate\ndata: {"scope":"run'));
        controller.enqueue(encoder.encode('time","version":2,"occurredAt":"2026-09-21T10:00:00.000Z"}\n\n'));
        controller.close();
      },
    });
    const listener = vi.fn();
    await consumeProductionEvents(stream, listener);
    expect(listener).toHaveBeenCalledWith({
      scope: 'runtime', version: 2, occurredAt: '2026-09-21T10:00:00.000Z',
    });
  });
});
