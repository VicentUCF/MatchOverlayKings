import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

type CpuTimes = { readonly idle: number; readonly total: number };
export type PilotHostMeasurement = {
  readonly cores: number;
  readonly cpuBusyRatio: number | null;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly availableStorageBytes: number;
};

/** Container limits take precedence over host totals; reclaimable cache is not treated as committed RAM. */
export async function measurePilotHost(directory: string, signal?: AbortSignal): Promise<PilotHostMeasurement> {
  const started = performance.now();
  const first = cpuTimes();
  const [limit, usage, memoryStats, quota, cpuBefore, storage] = await Promise.all([
    cgroup('memory.max'), cgroup('memory.current'), cgroup('memory.stat'), cgroup('cpu.max'), cgroup('cpu.stat'), statfs(directory),
  ]);
  await delay(250, undefined, { ...(signal ? { signal } : {}) });
  const cpuAfter = await cgroup('cpu.stat');
  const second = cpuTimes();
  const memoryLimit = positive(limit);
  const memoryUsage = positive(usage);
  const totalMemoryBytes = Math.min(totalmem(), memoryLimit ?? Infinity);
  const reclaimed = field(memoryStats, 'inactive_file') ?? 0;
  const availableMemoryBytes = Math.max(0, Math.min(freemem(), memoryLimit !== null && memoryUsage !== null
    ? memoryLimit - Math.max(0, memoryUsage - reclaimed) : Infinity));
  const [quotaValue, periodValue] = (quota ?? '').trim().split(/\s+/);
  const cpuQuota = positive(quotaValue); const cpuPeriod = positive(periodValue);
  const cores = Math.min(availableParallelism(), cpuQuota && cpuPeriod ? cpuQuota / cpuPeriod : Infinity);
  const beforeUsage = field(cpuBefore, 'usage_usec'); const afterUsage = field(cpuAfter, 'usage_usec');
  const elapsedMicros = (performance.now() - started) * 1_000;
  const totalDelta = second.total - first.total;
  const cpuBusyRatio = beforeUsage !== null && afterUsage !== null && elapsedMicros > 0
    ? Math.min(1, Math.max(0, (afterUsage - beforeUsage) / elapsedMicros / cores))
    : totalDelta > 0 ? Math.min(1, Math.max(0, 1 - (second.idle - first.idle) / totalDelta)) : null;
  return { cores, cpuBusyRatio, totalMemoryBytes, availableMemoryBytes,
    availableStorageBytes: Number(storage.bavail) * Number(storage.bsize) };
}

/** Only opens the transport. It never sends an RTMP publish command or media. */
export async function checkIngestTransport(ingestUrl: string, signal?: AbortSignal): Promise<{ milliseconds: number; encrypted: boolean }> {
  signal?.throwIfAborted();
  const target = new URL(ingestUrl);
  if (!['rtmp:', 'rtmps:'].includes(target.protocol) || !target.hostname) return Promise.reject(new Error('Invalid ingest transport'));
  const encrypted = target.protocol === 'rtmps:';
  const port = target.port ? Number(target.port) : encrypted ? 443 : 1935;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return Promise.reject(new Error('Invalid ingest port'));
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = encrypted ? tlsConnect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: true })
      : tcpConnect({ host: target.hostname, port });
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); socket.destroy();
      if (ok) resolve({ milliseconds: Math.round(performance.now() - started), encrypted });
      else reject(new Error('No se pudo comprobar la conexión con la entrada de vídeo.'));
    };
    const aborted = () => finish(false);
    const timer = setTimeout(aborted, 4_000); timer.unref();
    socket.once(encrypted ? 'secureConnect' : 'connect', () => finish(true));
    socket.on('error', aborted);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function cpuTimes(): CpuTimes {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((value, next) => value + next, 0) }), { idle: 0, total: 0 });
}
async function cgroup(name: string): Promise<string | null> {
  return readFile(`/sys/fs/cgroup/${name}`, 'utf8').catch(() => null);
}
function positive(value: string | null | undefined): number | null {
  const number = Number(value?.trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}
function field(text: string | null, key: string): number | null {
  const value = text?.split('\n').find((line) => line.startsWith(`${key} `))?.split(/\s+/)[1];
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
