import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FfmpegCourtPipeline } from '../src/ffmpeg-court-pipeline.js';
import type { FfmpegCourtPipelineOptions } from '../src/ffmpeg-court-pipeline-model.js';
import { NodeProcessSpawner } from '../src/managed-process.js';
import { NodeScheduler } from '../src/process-stop.js';
import { createContext, deferred, snapshot, target, TestFailure } from './ffmpeg-court-pipeline-fixture.js';

const CHILD_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const progress = fs.createWriteStream(null, { fd: 3 });
const input = fs.createReadStream(null, { fd: 4 });
let inputBytes = 0;
input.on('data', (chunk) => { inputBytes += chunk.length; });
progress.write('frame=1\\nout_time_us=N/A\\nfps=60\\nspeed=1x\\nprogress=continue\\n');
process.on('SIGTERM', () => {
  progress.end(() => process.exit(inputBytes > 0 ? 0 : 2));
});
setInterval(() => {}, 1000);
`;

function closingChildSource(outcome: 'nonzero' | 'signal' | 'clean'): string {
  const termination = outcome === 'signal'
    ? "process.kill(process.pid, 'SIGKILL')"
    : `process.exit(${outcome === 'nonzero' ? 7 : 0})`;
  return `#!/usr/bin/env node
const fs = require('node:fs');
const progress = fs.createWriteStream(null, { fd: 3 });
progress.write('frame=1\\nout_time_us=N/A\\nfps=60\\nspeed=1x\\nprogress=continue\\n');
progress.end(() => setImmediate(() => ${termination}));
`;
}

async function within<Value>(operation: Promise<Value>): Promise<Value> {
  const controller = new AbortController();
  const timeout = new NodeScheduler().wait(2_000, controller.signal).then(() => {
    throw new TestFailure('Real Node smoke exceeded its bound');
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    controller.abort();
  }
}

async function startClosingChild(outcome: 'nonzero' | 'signal' | 'clean'): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), 'kpl-ffmpeg-close-'));
  const executable = join(root, 'fake-ffmpeg.cjs');
  try {
    await writeFile(executable, closingChildSource(outcome), { mode: 0o700 });
    await chmod(executable, 0o700);
    const context = createContext();
    const options: FfmpegCourtPipelineOptions = {
      ...context.options,
      config: { ...context.options.config, ffmpegExecutablePath: executable, runtimeDirectoryPath: root },
      spawner: new NodeProcessSpawner(),
      scheduler: new NodeScheduler(),
      clock: { nowMs: () => performance.now() },
      mediaInspector: { inspectPaths: async () => snapshot(false) },
    };
    return await within(new FfmpegCourtPipeline(options).start(target(), new AbortController().signal));
  } catch (error) {
    return error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('FFmpeg court pipeline real Node smoke', () => {
  it('attributes fd3 EOF before a nonzero child close to process failure', async () => {
    // Given
    const outcome = 'nonzero' as const;

    // When
    const error = await startClosingChild(outcome);

    // Then
    expect(error).toMatchObject({ code: 'PROCESS_FAILED' });
  });

  it('attributes fd3 EOF before a signaled child close to process failure', async () => {
    // Given
    const outcome = 'signal' as const;

    // When
    const error = await startClosingChild(outcome);

    // Then
    expect(error).toMatchObject({ code: 'PROCESS_FAILED' });
  });

  it('attributes fd3 EOF before a clean child close without progress end to progress failure', async () => {
    // Given
    const outcome = 'clean' as const;

    // When
    const error = await startClosingChild(outcome);

    // Then
    expect(error).toMatchObject({ code: 'PROGRESS_FAILED' });
  });

  it('owns fd3 and fd4 and reaps a deterministic local child', async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), 'kpl-ffmpeg-pipeline-'));
    const executable = join(root, 'fake-ffmpeg.cjs');
    const sourceGate = deferred<void>();
    let pipeline: FfmpegCourtPipeline | null = null;
    let runtime: Awaited<ReturnType<FfmpegCourtPipeline['start']>> | null = null;
    try {
      await writeFile(executable, CHILD_SOURCE, { mode: 0o700 });
      await chmod(executable, 0o700);
      const context = createContext({ overlay: true });
      let inspections = 0;
      const options: FfmpegCourtPipelineOptions = {
        ...context.options,
        config: { ...context.options.config, ffmpegExecutablePath: executable, runtimeDirectoryPath: root },
        spawner: new NodeProcessSpawner(),
        scheduler: new NodeScheduler(),
        clock: { nowMs: () => performance.now() },
        mediaInspector: {
          inspectPaths: async () => {
            inspections += 1;
            return snapshot(inspections > 1);
          },
        },
        overlayFactory: { create: () => ({
          descriptor: context.options.overlayFactory?.create(target(true))?.descriptor
            ?? (() => { throw new TestFailure('Missing overlay descriptor'); })(),
          frames: (async function* () {
            yield new Uint8Array([1, 2, 3, 4]);
            await sourceGate.promise;
          })(),
        }) },
      };
      pipeline = new FfmpegCourtPipeline(options);

      // When
      runtime = await within(pipeline.start(target(true), new AbortController().signal));
      await within(pipeline.stop(runtime, new AbortController().signal));

      // Then
      expect(await pipeline.getRuntime(runtime.outputId, new AbortController().signal)).toBeNull();
      expect(inspections).toBeGreaterThanOrEqual(2);
    } finally {
      sourceGate.resolve();
      if (pipeline !== null && runtime !== null) {
        await within(pipeline.stop(runtime, AbortSignal.abort()));
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
