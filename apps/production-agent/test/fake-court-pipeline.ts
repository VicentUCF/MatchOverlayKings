import type { OutputId } from '@kpl/production-contracts';
import {
  fingerprintProfile,
  PipelineRuntimeSchema,
  type CourtSnapshot,
  type CourtPipelinePort,
  type PipelineRuntime,
  type PipelineTarget,
} from '../src/index.js';
import { ActivePipelineTracker, deferred, FakePipelineError } from './fake-support.js';

export { ActivePipelineTracker, deferred, type Deferred } from './fake-support.js';

type PlannedRejection = { readonly value: unknown };

export class FakeCourtPipelinePort implements CourtPipelinePort {
  readonly events: string[] = [];
  readonly inspectionSignals: AbortSignal[] = [];
  readonly startSignals: AbortSignal[] = [];
  readonly stopSignals: AbortSignal[] = [];
  readonly firstInspectionEntered = deferred();
  readonly firstStartEntered = deferred();
  readonly firstStopEntered = deferred();
  private readonly tracker: ActivePipelineTracker;
  private currentRuntime: PipelineRuntime | null = null;
  private startBarrier: Promise<void> | null = null;
  private stopBarrier: Promise<void> | null = null;
  private inspectionBarrier: Promise<void> | null = null;
  private startFailure: Error | null = null;
  private stopRejection: PlannedRejection | null = null;
  private inspectionFailures = 0;
  private acceptAbortedStart = false;
  private inspections = 0;

  public constructor(tracker = new ActivePipelineTracker()) {
    this.tracker = tracker;
  }

  public get startCount(): number {
    return this.events.filter((event) => event === 'start').length;
  }

  public get stopCount(): number {
    return this.events.filter((event) => event === 'stop').length;
  }

  public get inspectionCount(): number {
    return this.inspections;
  }

  public readonly getRuntime = async (
    outputId: OutputId,
    signal: AbortSignal,
  ): Promise<PipelineRuntime | null> => {
    void outputId;
    this.inspections += 1;
    this.inspectionSignals.push(signal);
    this.firstInspectionEntered.resolve();
    if (signal.aborted) throw new FakePipelineError('Inspection aborted');
    if (this.inspectionFailures > 0) {
      this.inspectionFailures -= 1;
      throw new FakePipelineError('Synthetic inspection failure');
    }
    const barrier = this.inspectionBarrier;
    this.inspectionBarrier = null;
    if (barrier !== null) await barrier;
    return this.currentRuntime;
  };

  public readonly start = async (
    target: PipelineTarget,
    signal: AbortSignal,
  ): Promise<PipelineRuntime> => {
    this.events.push('start');
    this.startSignals.push(signal);
    this.firstStartEntered.resolve();
    if (this.currentRuntime !== null) throw new FakePipelineError('Pipeline overlap');
    if (this.startFailure !== null) {
      const failure = this.startFailure;
      this.startFailure = null;
      throw failure;
    }
    const barrier = this.startBarrier;
    this.startBarrier = null;
    if (barrier !== null) await barrier;
    if (signal.aborted && !this.acceptAbortedStart) throw new FakePipelineError('Start aborted');
    const runtime = PipelineRuntimeSchema.parse({
      outputId: target.output.id,
      appliedDesiredVersion: target.desired.version,
      profileFingerprint: target.profileFingerprint,
    });
    this.currentRuntime = runtime;
    this.tracker.activate();
    return runtime;
  };

  public readonly stop = async (
    runtime: PipelineRuntime,
    signal: AbortSignal,
  ): Promise<void> => {
    void runtime;
    this.events.push('stop');
    this.stopSignals.push(signal);
    this.firstStopEntered.resolve();
    const barrier = this.stopBarrier;
    this.stopBarrier = null;
    if (barrier !== null) await barrier;
    if (this.stopRejection !== null) {
      const rejection = this.stopRejection;
      this.stopRejection = null;
      return Promise.reject(rejection.value);
    }
    if (signal.aborted) throw new FakePipelineError('Stop aborted');
    if (this.currentRuntime !== null) this.tracker.deactivate();
    this.currentRuntime = null;
  };

  public seedRuntime(runtime: PipelineRuntime): void {
    if (this.currentRuntime === null) this.tracker.activate();
    this.currentRuntime = runtime;
  }

  public blockNextStart(barrier: Promise<void>): void {
    this.startBarrier = barrier;
  }

  public blockNextInspection(barrier: Promise<void>): void {
    this.inspectionBarrier = barrier;
  }

  public blockNextStop(barrier: Promise<void>): void {
    this.stopBarrier = barrier;
  }

  public failNextStart(): void {
    this.startFailure = new FakePipelineError('Synthetic start failure');
  }

  public failNextGetRuntime(count = 1): void {
    this.inspectionFailures = count;
  }

  public failNextStop(): void {
    this.stopRejection = { value: new FakePipelineError('Synthetic stop failure') };
  }

  public rejectNextStop(value: unknown): void {
    this.stopRejection = { value };
  }

  public resolveStartDespiteAbort(): void {
    this.acceptAbortedStart = true;
  }
}

export function runtimeForSnapshot(snapshot: CourtSnapshot, outputId = snapshot.output.id) {
  return PipelineRuntimeSchema.parse({
    outputId,
    appliedDesiredVersion: snapshot.desired.version,
    profileFingerprint: fingerprintProfile(snapshot.desired.desired.profile),
  });
}

export function fakeCourtPorts(tracker = new ActivePipelineTracker()) {
  return [
    new FakeCourtPipelinePort(tracker),
    new FakeCourtPipelinePort(tracker),
    new FakeCourtPipelinePort(tracker),
    new FakeCourtPipelinePort(tracker),
  ] as const;
}
