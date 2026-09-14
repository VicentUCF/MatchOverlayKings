import {
  NodeProcessSpawner,
  NodeScheduler,
  type ManagedProcessPort,
  type ProcessCommandPlan,
} from '../src/index.js';

export function nodePlan(
  script: string,
  stdio: ProcessCommandPlan['stdio'] = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  executable = process.execPath,
): ProcessCommandPlan {
  return Object.freeze({
    executable,
    argv: Object.freeze(['-e', script]),
    cwd: process.cwd(),
    env: Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
    stdio: Object.freeze(stdio),
    shell: false,
  });
}

export async function withManagedChild<T>(
  command: ProcessCommandPlan,
  run: (child: ManagedProcessPort) => Promise<T>,
): Promise<T> {
  const child = await new NodeProcessSpawner().spawn(command);
  try {
    return await run(child);
  } finally {
    await cleanupManagedChild(child);
  }
}

export async function cleanupManagedChild(child: ManagedProcessPort): Promise<void> {
  if (child.status().state === 'running') {
    const delivery = child.signal('SIGKILL');
    if (delivery.state === 'failed') {
      child.releaseHandles();
      return;
    }
  }
  const closed = await bounded(child.close);
  if (closed.state === 'timeout') child.releaseHandles();
}

export type BoundedResult<T> =
  | { readonly state: 'settled'; readonly value: T }
  | { readonly state: 'timeout' };

export async function bounded<T>(promise: Promise<T>): Promise<BoundedResult<T>> {
  const controller = new AbortController();
  const result = await Promise.race([
    promise.then((value): BoundedResult<T> => ({ state: 'settled', value })),
    new NodeScheduler().wait(200, controller.signal)
      .then((): BoundedResult<T> => ({ state: 'timeout' })),
  ]);
  controller.abort();
  return result;
}
