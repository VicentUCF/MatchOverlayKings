import { describe, expect, it, vi } from 'vitest';
import { JsonRecordingSnapshotStore } from '../src/features/recordings/recording-snapshot-store.js';

describe('JsonRecordingSnapshotStore', () => {
  it('commits concurrent snapshots in request order', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const committed: unknown[] = [];
    const writer = vi.fn(async (_path: string, snapshot: unknown) => {
      if (committed.length === 0) await firstBlocked;
      committed.push(snapshot);
    });
    const store = new JsonRecordingSnapshotStore('/tmp/recording-library.json', writer);

    const first = store.write({ revision: 1 });
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1));
    const second = store.write({ revision: 2 });
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(committed).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it('continues serializing after one failed write', async () => {
    const writer = vi.fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce(undefined);
    const store = new JsonRecordingSnapshotStore('/tmp/recording-library.json', writer);

    await expect(store.write({ revision: 1 })).rejects.toThrow('disk unavailable');
    await expect(store.write({ revision: 2 })).resolves.toBeUndefined();
    expect(writer).toHaveBeenCalledTimes(2);
  });
});
