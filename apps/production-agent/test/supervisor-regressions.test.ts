import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { CourtSnapshotSchema, Supervisor } from '../src/index.js';
import {
  ActivePipelineTracker,
  deferred,
  fakeCourtPorts,
  runtimeForSnapshot,
} from './fake-court-pipeline.js';
import {
  COURT_IDS,
  agentConfig,
  courtSnapshot,
  runningSnapshots,
} from './supervisor-fixtures.js';

type InvalidRelation = 'desired-output' | 'observed-club' | 'profile-court';

class UnexpectedRelationError extends Error {
  public constructor() {
    super('Unexpected invalid relation');
    this.name = 'UnexpectedRelationError';
  }
}

function invalidSnapshots(relation: InvalidRelation) {
  const base = courtSnapshot(0);
  const invalidFirst = (() => {
    switch (relation) {
      case 'desired-output':
        return { ...base, desired: { ...base.desired, outputId: courtSnapshot(1).output.id } };
      case 'observed-club':
        return {
          ...base,
          observed: { ...base.observed, clubId: '31000000-0000-4000-8000-000000000002' },
        };
      case 'profile-court':
        return {
          ...base,
          desired: {
            ...base.desired,
            desired: {
              ...base.desired.desired,
              profile: { ...base.desired.desired.profile, courtId: COURT_IDS[1] },
            },
          },
        };
      default:
        return assertNever(relation);
    }
  })();
  return [invalidFirst, courtSnapshot(1), courtSnapshot(2), courtSnapshot(3)] as const;
}

describe('Supervisor correctness regressions', () => {
  it('reserves unknown occupancy and never starts beyond the hard cap', async () => {
    const tracker = new ActivePipelineTracker();
    const ports = fakeCourtPorts(tracker);
    for (const slot of [0, 1, 2] as const) {
      const snapshot = CourtSnapshotSchema.parse(courtSnapshot(slot));
      ports[slot].seedRuntime(runtimeForSnapshot(snapshot));
    }
    ports[2].failNextGetRuntime();
    const supervisor = new Supervisor(agentConfig(), ports);

    const result = await supervisor.reconcile(runningSnapshots());

    expect(result.courts[2]).toMatchObject({ kind: 'failed' });
    expect(result.courts[3]).toMatchObject({ kind: 'degraded', reason: 'capacity' });
    expect(ports[3].startCount).toBe(0);
    expect(tracker.peak).toBe(3);
  });

  it.each<InvalidRelation>(['desired-output', 'observed-club', 'profile-court'])(
    'rejects %s mismatch before any pipeline inspection or action',
    async (relation) => {
      const ports = fakeCourtPorts();
      const supervisor = new Supervisor(agentConfig(), ports);

      const reconciliation = supervisor.reconcile(invalidSnapshots(relation));

      await expect(reconciliation).rejects.toBeInstanceOf(ZodError);
      expect(ports.map((port) => port.inspectionCount)).toEqual([0, 0, 0, 0]);
      expect(ports.flatMap((port) => port.events)).toEqual([]);
    },
  );

  it('does not reuse stale inspection state across repeated supervisor rounds', async () => {
    const ports = fakeCourtPorts();
    const supervisor = new Supervisor(agentConfig(), ports);
    await supervisor.reconcile(runningSnapshots());
    ports[0].failNextGetRuntime();

    const secondRound = await supervisor.reconcile(runningSnapshots());

    expect(secondRound.courts[0]).toMatchObject({ kind: 'failed' });
    expect(ports.map((port) => port.startCount)).toEqual([1, 1, 1, 0]);
  });

  it('retries cleanup after a failed shutdown court result', async () => {
    const ports = fakeCourtPorts();
    const supervisor = new Supervisor(agentConfig(), ports);
    await supervisor.reconcile(runningSnapshots());
    ports[0].failNextStop();

    const failedShutdown = await supervisor.shutdown();
    const retriedShutdown = await supervisor.shutdown();

    expect(failedShutdown.courts[0]).toMatchObject({ kind: 'failed' });
    expect(retriedShutdown.courts[0]).toMatchObject({ kind: 'stopped' });
    expect(ports[0].stopCount).toBe(2);
  });

  it('retries shutdown after aggregate cleanup rejects with a non-Error value', async () => {
    const ports = fakeCourtPorts();
    const supervisor = new Supervisor(agentConfig(), ports);
    await supervisor.reconcile(runningSnapshots());
    ports[0].rejectNextStop('synthetic shutdown rejection');

    await expect(supervisor.shutdown()).rejects.toBe('synthetic shutdown rejection');
    const retriedShutdown = await supervisor.shutdown();

    expect(retriedShutdown.courts[0]).toMatchObject({ kind: 'stopped' });
    expect(ports[0].stopCount).toBe(2);
  });

  it('memoizes shutdown while in flight and after total success', async () => {
    const ports = fakeCourtPorts();
    const supervisor = new Supervisor(agentConfig(), ports);
    await supervisor.reconcile(runningSnapshots());
    const gate = deferred();
    ports[0].blockNextStop(gate.promise);

    const firstShutdown = supervisor.shutdown();
    await ports[0].firstStopEntered.promise;
    const inFlightShutdown = supervisor.shutdown();
    gate.resolve();
    await firstShutdown;
    const completedShutdown = supervisor.shutdown();

    expect(inFlightShutdown).toBe(firstShutdown);
    expect(completedShutdown).toBe(firstShutdown);
  });

  it('reports an in-flight reconciliation as cancelled when shutdown wins the race', async () => {
    const ports = fakeCourtPorts();
    ports[0].resolveStartDespiteAbort();
    const gate = deferred();
    ports[0].blockNextStart(gate.promise);
    const supervisor = new Supervisor(agentConfig(), ports);

    const reconciliation = supervisor.reconcile(runningSnapshots());
    await ports[0].firstStartEntered.promise;
    const shutdown = supervisor.shutdown();
    gate.resolve();
    const [reconciliationResult, shutdownResult] = await Promise.all([
      reconciliation,
      shutdown,
    ]);

    expect(reconciliationResult.courts.map((court) => court.kind)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(shutdownResult.courts[0]).toMatchObject({ kind: 'stopped' });
    expect(ports[0].stopCount).toBe(1);
  });
});

function assertNever(value: never): never {
  void value;
  throw new UnexpectedRelationError();
}
