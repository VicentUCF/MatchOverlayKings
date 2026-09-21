import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductionEventBus, productionSseEvent } from '../src/production-events.js';

afterEach(() => { vi.useRealTimers(); });

describe('production invalidation events', () => {
  it('coalesces noisy runtime changes and retains the newest version', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00.000Z'));
    const bus = new ProductionEventBus();
    const received: Array<{ scope: string; version: number }> = [];
    bus.subscribe((event) => received.push(event));

    bus.publish('runtime');
    bus.publish('runtime');
    vi.advanceTimersByTime(1_999);
    expect(received).toEqual([{ scope: 'runtime', version: 1, occurredAt: expect.any(String) }]);
    vi.advanceTimersByTime(1);
    expect(received.at(-1)).toMatchObject({ scope: 'runtime', version: 2 });
    bus.close();
  });

  it('serializes an SSE event without exposing state', () => {
    const payload = productionSseEvent({ scope: 'recordings', version: 4, occurredAt: '2026-09-21T10:00:00.000Z' });
    expect(payload).toBe('event: invalidate\ndata: {"scope":"recordings","version":4,"occurredAt":"2026-09-21T10:00:00.000Z"}\n\n');
  });

  it('notifies open streams when the bus closes', () => {
    const bus = new ProductionEventBus();
    const close = vi.fn();
    bus.subscribe(() => undefined, close);
    bus.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
