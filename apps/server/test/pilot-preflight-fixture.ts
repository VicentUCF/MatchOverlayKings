import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PilotPreflightDependencies } from '../src/pilot-service.js';

/** Isolates lifecycle tests from the real media probe, covered in pilot-preflight-media.test.ts. */
export const passingPreflight: PilotPreflightDependencies = {
  host: async () => ({ cores: 4, cpuBusyRatio: 0.1, totalMemoryBytes: 8 * 1024 ** 3,
    availableMemoryBytes: 4 * 1024 ** 3, availableStorageBytes: 20 * 1024 ** 3 }),
  transport: async () => ({ milliseconds: 5, encrypted: true }),
  upload: async () => ({ kbps: 100_000, checkedAt: new Date().toISOString(), bytes: 2 * 1024 ** 2 }),
  media: async (options) => {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    await writeFile(options.path, 'LOCAL PREVIEW FIXTURE', { mode: 0o600 });
    return { completed: true, cameraReceived: true, cameraInterrupted: false, overlayReceived: true,
      overlayInterrupted: false, hardwareFailure: false, durationSeconds: 10, frames: options.source.fps * 10,
      sizeBytes: 7_500_000, elapsedSeconds: 11,
      signal: { sampledAt: new Date().toISOString(), checking: false, lastVideoSampleAt: new Date().toISOString(),
        audioExpected: options.audioExpected, measuredSpeed: 1, measuredFramesPerSecond: options.source.fps,
        measuredBitrateKbps: 6_000, droppedFrameRatio: 0, issues: [] } };
  },
};
