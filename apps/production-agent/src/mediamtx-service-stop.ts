import type { ManagedProcessPort, ProcessCloseStatus } from './managed-process.js';
import { type SchedulerPort, stopMediaMtx } from './process-stop.js';

export function stopMediaMtxProcess(
  process: ManagedProcessPort,
  scheduler: SchedulerPort,
  graceMs: number,
): Promise<ProcessCloseStatus> {
  return stopMediaMtx({
    process,
    scheduler,
    graceMs,
    signal: new AbortController().signal,
  });
}
