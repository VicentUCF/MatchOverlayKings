import { readFile } from 'node:fs/promises';
import { writePrivateJson } from '../../private-json.js';

export interface RecordingSnapshotStore {
  read(): Promise<unknown>;
  write(snapshot: unknown): Promise<void>;
}

type SnapshotWriter = (path: string, snapshot: unknown) => Promise<void>;

/**
 * Keeps atomic file replacement ordered as well as durable. Without this queue,
 * an older snapshot can finish after a newer one and become the restart state.
 */
export class JsonRecordingSnapshotStore implements RecordingSnapshotStore {
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly path: string,
    private readonly writer: SnapshotWriter = writePrivateJson,
  ) {}

  public async read(): Promise<unknown> {
    return JSON.parse(await readFile(this.path, 'utf8')) as unknown;
  }

  public async write(snapshot: unknown): Promise<void> {
    const write = () => this.writer(this.path, snapshot);
    const operation = this.writeTail.then(write, write);
    this.writeTail = operation.catch(() => undefined);
    await operation;
  }
}
