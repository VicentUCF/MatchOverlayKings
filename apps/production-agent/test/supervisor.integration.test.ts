import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/index.js';
import { ActivePipelineTracker, fakeCourtPorts } from './fake-court-pipeline.js';
import {
  COURT_IDS,
  agentConfig,
  courtSnapshot,
  runningSnapshots,
} from './supervisor-fixtures.js';

describe('Supervisor configuration', () => {
  it('requires exactly four configured courts', () => {
    const ports = fakeCourtPorts();
    const config = { courts: agentConfig().courts.slice(0, 3), maxConcurrentPipelines: 3 };

    const constructSupervisor = () => new Supervisor(config, ports);

    expect(constructSupervisor).toThrow(ZodError);
  });

  it('requires four unique configured courts', () => {
    const ports = fakeCourtPorts();
    const config = {
      courts: [
        { courtId: COURT_IDS[0] },
        { courtId: COURT_IDS[0] },
        { courtId: COURT_IDS[2] },
        { courtId: COURT_IDS[3] },
      ],
      maxConcurrentPipelines: 3,
    };

    const constructSupervisor = () => new Supervisor(config, ports);

    expect(constructSupervisor).toThrow(ZodError);
  });

  it('requires the approved maximum of three active pipelines', () => {
    const ports = fakeCourtPorts();
    const config = { ...agentConfig(), maxConcurrentPipelines: 4 };

    const constructSupervisor = () => new Supervisor(config, ports);

    expect(constructSupervisor).toThrow(ZodError);
  });
});

describe('Supervisor reconciliation', () => {
  it('admits three courts, retains them, replaces a stopped court, and shuts down', async () => {
    const ports = fakeCourtPorts();
    const supervisor = new Supervisor(agentConfig(), ports);

    const initial = await supervisor.reconcile(runningSnapshots());

    expect(ports.map((port) => port.startCount)).toEqual([1, 1, 1, 0]);
    expect(initial.courts[3]).toMatchObject({ kind: 'degraded', reason: 'capacity' });

    const courtTwoBase = courtSnapshot(1);
    const changedCourtTwo = {
      ...courtTwoBase,
      desired: {
        ...courtTwoBase.desired,
        desired: {
          ...courtTwoBase.desired.desired,
          profile: { ...courtTwoBase.desired.desired.profile, overlayEnabled: false },
        },
      },
    };
    await supervisor.reconcile([
      courtSnapshot(0),
      changedCourtTwo,
      courtSnapshot(2),
      courtSnapshot(3),
    ]);

    expect(ports.map((port) => port.events)).toEqual([
      ['start'],
      ['start', 'stop', 'start'],
      ['start'],
      [],
    ]);

    await supervisor.reconcile([
      courtSnapshot(0),
      courtSnapshot(1, 'stopped'),
      courtSnapshot(2),
      courtSnapshot(3),
    ]);

    expect(ports.map((port) => port.startCount)).toEqual([1, 2, 1, 1]);
    expect(ports[1].stopCount).toBe(2);

    const startsBeforeShutdown = ports.map((port) => port.startCount);
    const shutdown = await supervisor.shutdown();

    expect(shutdown.courts.map((court) => court.kind)).toEqual([
      'stopped',
      'idle',
      'stopped',
      'stopped',
    ]);
    expect(ports.map((port) => port.startCount)).toEqual(startsBeforeShutdown);
    expect(ports.flatMap((port) => port.startSignals).every((signal) => signal.aborted)).toBe(
      true,
    );
  });

  it('backfills after one court fails without exceeding capacity', async () => {
    const tracker = new ActivePipelineTracker();
    const ports = fakeCourtPorts(tracker);
    ports[1].failNextStart();
    const supervisor = new Supervisor(agentConfig(), ports);

    const result = await supervisor.reconcile(runningSnapshots());

    expect(result.courts.map((court) => court.kind)).toEqual([
      'reconciled',
      'failed',
      'reconciled',
      'reconciled',
    ]);
    expect(ports.map((port) => port.startCount)).toEqual([1, 1, 1, 1]);
    expect(tracker.peak).toBe(3);
  });
});
