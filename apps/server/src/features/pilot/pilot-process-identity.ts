import { readFileSync } from 'node:fs';

export type PilotProcessIdentity = { readonly pid: number; readonly startTime: string; readonly bootId?: string | undefined };

/** Linux start ticks distinguish our encoder from an unrelated process reusing its PID. */
export function encoderProcessIdentity(pid: number | undefined): PilotProcessIdentity | null {
  if (process.platform !== 'linux' || pid === undefined || pid <= 1 || pid === process.pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = fields[19];
    if (fields[0] === 'Z' || startTime === undefined || !/^\d+$/.test(startTime)) return null;
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return { pid, startTime, bootId };
  } catch { return null; }
}

export async function stopOrphanedEncoder(identity: PilotProcessIdentity): Promise<boolean> {
  const matches = () => {
    const current = encoderProcessIdentity(identity.pid);
    return identity.bootId !== undefined && current?.startTime === identity.startTime && current.bootId === identity.bootId;
  };
  if (!matches()) return false;
  try { process.kill(identity.pid, 'SIGTERM'); } catch (error) {
    if (!matches()) return true;
    throw error;
  }
  const deadline = Date.now() + 2_000;
  while (matches() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (matches()) {
    try { process.kill(identity.pid, 'SIGKILL'); } catch (error) { if (matches()) throw error; }
    const killDeadline = Date.now() + 1_000;
    while (matches() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (matches()) throw new Error('El encoder anterior sigue activo. No se habilitará una salida duplicada.');
  }
  return true;
}
