import { OutputIdSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { CourtSnapshotSchema, CourtWorker, CourtWorkerConfigSchema } from '../src/index.js';
import {
  ActivePipelineTracker,
  deferred,
  FakeCourtPipelinePort,
  runtimeForSnapshot,
} from './fake-court-pipeline.js';
import { COURT_IDS, OUTPUT_IDS, courtSnapshot } from './supervisor-fixtures.js';

function workerWithFake(fake: FakeCourtPipelinePort) {
  const config = CourtWorkerConfigSchema.parse({ courtId: COURT_IDS[0] });
  return new CourtWorker(config, fake);
}

describe('CourtWorker regressions', () => {
  it('rejects an inspected runtime belonging to another output', async () => {
    const fake = new FakeCourtPipelinePort();
    const worker = workerWithFake(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));
    const otherOutputId = OutputIdSchema.parse(OUTPUT_IDS[1]);
    fake.seedRuntime(runtimeForSnapshot(snapshot, otherOutputId));

    const result = await worker.reconcile(snapshot, 'admitted');

    expect(result).toMatchObject({ kind: 'failed' });
    expect(worker.isActive).toBe(false);
    expect(fake.events).toEqual([]);
  });

  it('does not reuse a successful inspection after later inspections fail', async () => {
    const fake = new FakeCourtPipelinePort();
    const worker = workerWithFake(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));
    await worker.inspect(snapshot);
    fake.failNextGetRuntime(2);

    const failedInspection = await worker.inspect(snapshot);
    const reconciliation = await worker.reconcile(snapshot, 'admitted');

    expect(failedInspection).toMatchObject({ kind: 'failed' });
    expect(reconciliation).toMatchObject({ kind: 'failed' });
    expect(fake.startCount).toBe(0);
    expect(fake.inspectionCount).toBe(3);
  });

  it('reports cancellation and stops a start that resolves after abort', async () => {
    const tracker = new ActivePipelineTracker();
    const fake = new FakeCourtPipelinePort(tracker);
    fake.resolveStartDespiteAbort();
    const gate = deferred();
    fake.blockNextStart(gate.promise);
    const worker = workerWithFake(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));

    const reconciliation = worker.reconcile(snapshot, 'admitted');
    await fake.firstStartEntered.promise;
    const shutdown = worker.shutdown();
    gate.resolve();
    const [reconciliationResult, shutdownResult] = await Promise.all([reconciliation, shutdown]);

    expect(reconciliationResult).toMatchObject({ kind: 'cancelled', reason: 'shutdown' });
    expect(shutdownResult).toMatchObject({ kind: 'stopped' });
    expect(fake.stopCount).toBe(1);
    expect(tracker.active).toBe(0);
  });

  it('stops a runtime returned by inspection after shutdown begins', async () => {
    const tracker = new ActivePipelineTracker();
    const fake = new FakeCourtPipelinePort(tracker);
    const gate = deferred();
    fake.blockNextInspection(gate.promise);
    const worker = workerWithFake(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));
    fake.seedRuntime(runtimeForSnapshot(snapshot));

    const reconciliation = worker.reconcile(snapshot, 'admitted');
    await fake.firstInspectionEntered.promise;
    const shutdown = worker.shutdown();
    gate.resolve();
    const [reconciliationResult, shutdownResult] = await Promise.all([reconciliation, shutdown]);

    expect(reconciliationResult).toMatchObject({ kind: 'cancelled', reason: 'shutdown' });
    expect(shutdownResult).toMatchObject({ kind: 'stopped' });
    expect(fake.stopCount).toBe(1);
    expect(tracker.active).toBe(0);
  });
});
