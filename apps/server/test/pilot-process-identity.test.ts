import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { encoderProcessIdentity, stopOrphanedEncoder } from '../src/pilot-process-identity.js';

const processes: ChildProcess[] = [];
afterEach(() => { for (const child of processes.splice(0)) child.kill('SIGKILL'); });

describe.skipIf(process.platform !== 'linux')('orphan encoder identity', () => {
  it('stops only a process with the exact persisted start time', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    processes.push(child);
    const identity = encoderProcessIdentity(child.pid);
    expect(identity).not.toBeNull();
    if (!identity) throw new Error('missing child identity');
    expect(await stopOrphanedEncoder({ ...identity, startTime: `${identity.startTime}0` })).toBe(false);
    expect(await stopOrphanedEncoder({ ...identity, bootId: 'another-boot' })).toBe(false);
    expect(await stopOrphanedEncoder({ pid: identity.pid, startTime: identity.startTime })).toBe(false);
    expect(encoderProcessIdentity(child.pid)).toEqual(identity);
    expect(await stopOrphanedEncoder(identity)).toBe(true);
    expect(encoderProcessIdentity(child.pid)).toBeNull();
  });

  it('never treats the server itself or PID 1 as a recoverable encoder', async () => {
    expect(encoderProcessIdentity(process.pid)).toBeNull();
    expect(encoderProcessIdentity(1)).toBeNull();
    expect(await stopOrphanedEncoder({ pid: process.pid, startTime: '1' })).toBe(false);
  });
});
