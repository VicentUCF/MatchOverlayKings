import { describe, expect, it } from 'vitest';
import { CourtSnapshotSchema, CourtWorker, CourtWorkerConfigSchema } from '../src/index.js';
import { deferred, FakeCourtPipelinePort } from './fake-court-pipeline.js';
import { COURT_IDS, courtSnapshot } from './supervisor-fixtures.js';

function configuredWorker(fake: FakeCourtPipelinePort) {
  const config = CourtWorkerConfigSchema.parse({ courtId: COURT_IDS[0] });
  return new CourtWorker(config, fake);
}

describe('CourtWorker', () => {
  it('serializes reconciliations for one court without duplicate starts', async () => {
    const fake = new FakeCourtPipelinePort();
    const gate = deferred();
    fake.blockNextStart(gate.promise);
    const worker = configuredWorker(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));

    const firstReconciliation = worker.reconcile(snapshot, 'admitted');
    await fake.firstStartEntered.promise;
    const secondReconciliation = worker.reconcile(snapshot, 'admitted');

    expect(fake.startCount).toBe(1);
    gate.resolve();
    const results = await Promise.all([firstReconciliation, secondReconciliation]);
    expect(results.map((result) => result.kind)).toEqual(['reconciled', 'reconciled']);
    expect(fake.startCount).toBe(1);
  });

  it('executes restart as stop before start with no runtime overlap', async () => {
    const fake = new FakeCourtPipelinePort();
    const worker = configuredWorker(fake);
    const initial = CourtSnapshotSchema.parse(courtSnapshot(0));
    await worker.reconcile(initial, 'admitted');
    const changed = CourtSnapshotSchema.parse({
      ...courtSnapshot(0),
      desired: {
        ...courtSnapshot(0).desired,
        desired: {
          ...courtSnapshot(0).desired.desired,
          profile: { ...courtSnapshot(0).desired.desired.profile, videoBitrateKbps: 9_000 },
        },
      },
    });

    const result = await worker.reconcile(changed, 'admitted');

    expect(result.kind).toBe('reconciled');
    expect(fake.events).toEqual(['start', 'stop', 'start']);
  });

  it('recovers its serialized queue after a pipeline failure', async () => {
    const fake = new FakeCourtPipelinePort();
    fake.failNextStart();
    const worker = configuredWorker(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));

    const failed = await worker.reconcile(snapshot, 'admitted');
    const recovered = await worker.reconcile(snapshot, 'admitted');

    expect(failed).toMatchObject({ kind: 'failed' });
    expect(recovered).toMatchObject({ kind: 'reconciled' });
    expect(fake.startCount).toBe(2);
  });

  it('isolates a capacity stop failure as a typed worker result', async () => {
    const fake = new FakeCourtPipelinePort();
    const worker = configuredWorker(fake);
    const snapshot = CourtSnapshotSchema.parse(courtSnapshot(0));
    await worker.reconcile(snapshot, 'admitted');
    fake.failNextStop();

    const result = await worker.reconcile(snapshot, 'capacity-deferred');

    expect(result).toMatchObject({ kind: 'failed' });
    expect(worker.isActive).toBe(true);
  });
});
