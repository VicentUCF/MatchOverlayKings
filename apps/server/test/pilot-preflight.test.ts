import { createServer } from 'node:net';
import { expect, it, vi, afterEach } from 'vitest';
import { PilotPreflightCheckIdSchema, type PilotPreflight } from '@kpl/production-contracts';
import { runPilotPreflight, MEDIA_CHECKS } from '../src/pilot-preflight.js';
import { checkIngestTransport, measurePilotHost } from '../src/pilot-preflight-system.js';
import { checkPilotMetadata } from '../src/pilot-preflight-checks.js';

afterEach(() => vi.useRealTimers());
const success = { status: 'pass' as const, message: 'Comprobado' };
function checks() {
  const metadata = vi.fn(async () => success);
  const media = vi.fn(async () => ({ checks: Object.fromEntries(MEDIA_CHECKS.map((id) => [id, success])),
    preview: { url: '/api/pilot/sessions/11111111-1111-4111-8111-111111111111/preflight-preview/22222222-2222-4222-8222-222222222222', durationSeconds: 10, sizeBytes: 1_000_000 } }));
  const updates: PilotPreflight[] = [];
  return { metadata, media, updates, signal: new AbortController().signal, onUpdate: (report: PilotPreflight) => updates.push(report) };
}

it('retains the age of untouched checks when retrying and reuses the existing preview', async () => {
  vi.useFakeTimers();
  const first = checks();
  const previous = await runPilotPreflight(first);
  expect(previous.status).toBe('ready');
  expect(previous.checks.map(({ id }) => id)).toEqual(PilotPreflightCheckIdSchema.options);
  await vi.advanceTimersByTimeAsync(40_000);
  const retry = checks();
  const updated = await runPilotPreflight({ ...retry, previous, check: 'storage' });
  expect(updated.status).toBe('ready');
  expect(retry.metadata).toHaveBeenCalledExactlyOnceWith('storage');
  expect(retry.media).not.toHaveBeenCalled();
  expect(updated.preview).toEqual(previous.preview);
  expect(updated.validUntil).toBe(previous.validUntil);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect((await runPilotPreflight({ ...checks(), previous: updated, check: 'cpu' })).status).toBe('stale');
});

it('rechecks the composed media group together without rerunning unrelated checks', async () => {
  const previous = await runPilotPreflight(checks());
  const retry = checks();
  const updated = await runPilotPreflight({ ...retry, previous, check: 'audio' });
  expect(updated.status).toBe('ready');
  expect(retry.metadata).not.toHaveBeenCalled();
  expect(retry.media).toHaveBeenCalledOnce();
  expect(retry.updates[0]?.checks.filter(({ status }) => status === 'running').map(({ id }) => id).sort()).toEqual([...MEDIA_CHECKS].sort());
});

it('does not touch cameras or record media when preparation or disk checks block the run', async () => {
  const input = checks();
  const report = await runPilotPreflight({ ...input, metadata: async (id) => id === 'storage'
    ? { status: 'blocked', message: 'Sin espacio' } : success });
  expect(report.status).toBe('blocked');
  expect(report.preview).toBeNull();
  expect(input.media).not.toHaveBeenCalled();
});

it('bounds unresponsive metadata checks and never reports an incomplete run as ready', async () => {
  vi.useFakeTimers();
  const input = checks();
  const pending = runPilotPreflight({ ...input, metadata: () => new Promise(() => undefined) });
  await vi.advanceTimersByTimeAsync(20_001);
  const report = await pending;
  expect(report.status).toBe('blocked');
  expect(report.checks.every(({ status }) => status === 'blocked')).toBe(true);
});

it('requires cancellation to stay cancelled even when a dependency later returns a successful result', async () => {
  const abort = new AbortController();
  const input = checks();
  let finish!: () => void;
  const pending = runPilotPreflight({ ...input, signal: abort.signal, media: async () => {
    await new Promise<void>((resolve) => { finish = resolve; }); return input.media();
  } });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  abort.abort(); finish();
  expect((await pending).status).toBe('cancelled');
});

it('checks ingest reachability without sending stream keys, RTMP commands or media', async () => {
  let received = 0;
  const server = createServer((socket) => { socket.on('data', (data) => { received += data.length; }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local address');
  try {
    expect(await checkIngestTransport(`rtmp://127.0.0.1:${address.port}/private-secret`)).toMatchObject({ encrypted: false });
    expect(received).toBe(0);
    await expect(checkIngestTransport('https://127.0.0.1/secret')).rejects.toThrow();
    await expect(checkIngestTransport('invalid')).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(checkIngestTransport(`rtmp://127.0.0.1:${address.port}/secret`, abort.signal)).rejects.toThrow();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it('reports bounded local host capacity and explains that a transport handshake is not an upload test', async () => {
  const host = await measurePilotHost('/tmp');
  expect(host.availableStorageBytes).toBeGreaterThan(0);
  expect(host.cores).toBeGreaterThan(0);
  expect(host.availableMemoryBytes).toBeGreaterThanOrEqual(0);
  expect(host.availableMemoryBytes).toBeLessThanOrEqual(host.totalMemoryBytes);
  const check = await checkPilotMetadata('network', { source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' },
    mode: 'youtube', mobile: null, assertMatch: async () => undefined, host: async () => host,
    destination: async () => ({ broadcastStatus: 'ready', streamStatus: 'ready', healthStatus: 'good' }),
    transport: async () => ({ milliseconds: 2, encrypted: true }), mediaMtx: async () => false });
  expect(check.status).toBe('warning');
  expect(check.message).toContain('no mide la capacidad de subida');
});
