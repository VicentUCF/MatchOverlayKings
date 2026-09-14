import { describe, expect, it } from 'vitest';
import { CourtSnapshotSchema, ObservedStateProjector } from '../src/index.js';
import { reconciledResult } from './production-runtime-fixtures.js';
import { runningSnapshots } from './supervisor-fixtures.js';

describe('observed state projection', () => {
  it('increments from the snapshot sequence and never regresses', () => {
    const snapshot = CourtSnapshotSchema.parse(runningSnapshots()[0]);
    const result = reconciledResult(snapshot);
    const projector = new ObservedStateProjector();

    const first = projector.project(snapshot, result);
    const second = projector.project(snapshot, result);

    expect([first.sequence, second.sequence]).toEqual([2, 3]);
    expect(first).toMatchObject({ health: 'healthy', state: { status: 'running' } });
  });

  it('reports missing post-start runtime as failed', () => {
    const snapshot = CourtSnapshotSchema.parse(runningSnapshots()[0]);
    const result = { ...reconciledResult(snapshot), runtime: null };

    const command = new ObservedStateProjector().project(snapshot, result);

    expect(command).toMatchObject({ health: 'failed', state: { status: 'runtime_missing' } });
  });
});
