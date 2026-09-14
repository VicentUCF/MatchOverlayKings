import { describe, expect, it } from 'vitest';
import {
  NodeProcessSpawner,
  ProcessAdapterError,
} from '../src/index.js';
import { nodePlan, withManagedChild } from './managed-process-fixture.js';

const smokeScript = [
  "const fs = require('node:fs')",
  "if (Object.keys(process.env).sort().join(',') !== 'LANG,LC_ALL') process.exit(21)",
  "process.stdout.write('ready\\n')",
  "process.stderr.write('warning: smoke\\n')",
  "let input = ''",
  "const stream = fs.createReadStream(null, { fd: 4 })",
  "stream.on('data', chunk => { input += chunk })",
  "stream.on('end', () => {",
  "  if (input !== 'overlay') process.exit(22)",
  "  fs.writeSync(3, 'frame=1\\nout_time_us=1000\\nfps=30\\nspeed=1x\\nprogress=end\\n')",
  "  process.exit(0)",
  "})",
].join(';');

async function* overlayChunks(): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode('over');
  yield new TextEncoder().encode('lay');
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  let value = '';
  for await (const chunk of chunks) value += new TextDecoder().decode(chunk);
  return value;
}

describe('NodeProcessSpawner', () => {
  it('rejects spawn errors without exposing operating-system details', async () => {
    const result = new NodeProcessSpawner().spawn(nodePlan('', ['ignore'], '/missing/kpl-child'));

    await expect(result).rejects.toEqual(expect.objectContaining({
      code: 'SPAWN_FAILED',
      message: 'Managed process failed to spawn',
    }));
    await expect(result).rejects.toBeInstanceOf(ProcessAdapterError);
  });

  it('runs an isolated shell-free child and exposes bounded diagnostics', async () => {
    await withManagedChild(nodePlan(smokeScript), async (child) => {
      const progress = child.progress;
      if (progress === null) throw new TypeError('Expected fd3 progress');

      const collected = collect(progress);
      await child.pumpFd4(overlayChunks(), new AbortController().signal);
      const close = await child.close;

      expect(close).toEqual({ code: 0, signal: null });
      expect(await collected).toContain('progress=end');
      expect(child.diagnostics()).toMatchObject({ stdoutBytes: 6, stderrBytes: 15 });
      expect(nodePlan(smokeScript).argv.join(' ')).not.toMatch(/SECRET_SENTINEL|password|token/i);
    });
  });

  it('returns typed delivered and already-closed signal outcomes', async () => {
    await withManagedChild(nodePlan("setInterval(() => undefined, 1000)", ['ignore', 'pipe', 'pipe']), async (child) => {
      expect(child.signal('SIGTERM')).toEqual({ state: 'delivered' });
      await child.close;
      expect(child.signal('SIGKILL')).toEqual({ state: 'alreadyClosed' });
    });
  });
});
