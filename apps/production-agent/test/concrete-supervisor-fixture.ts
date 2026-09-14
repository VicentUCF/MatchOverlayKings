import {
  FfmpegCourtPipeline,
  MediaMtxService,
  Supervisor,
  type FfmpegCourtPipelineOptions,
  type LocalMediaRuntimeConfig,
  type MediaMtxPathsSnapshot,
} from '../src/index.js';
import { ActivePipelineTracker } from './fake-support.js';
import {
  ByteQueue,
  FakeProcess as FakeFfmpegProcess,
  FakeSpawner as FakeFfmpegSpawner,
  ManualClockScheduler,
  progress,
} from './ffmpeg-court-pipeline-fixture.js';
import {
  FakeApiClient,
  FakeArtifact,
  FakeCredential,
  FakeProcess as FakeMediaMtxProcess,
  FakeRuntimeFiles,
  FakeSpawner as FakeMediaMtxSpawner,
  PATHS,
  itemAt,
  mediaConfig,
} from './mediamtx-service-fixture.js';
import {
  COURT_IDS,
  VIDEO_DEVICE_IDS,
  agentConfig,
  courtSnapshot,
  type CourtSlot,
  type Lifecycle,
} from './supervisor-fixtures.js';

type Four<Value> = readonly [Value, Value, Value, Value];

export type CourtFfmpegFixture = {
  readonly pipeline: FfmpegCourtPipeline;
  readonly options: FfmpegCourtPipelineOptions;
  readonly spawner: FakeFfmpegSpawner;
  readonly processes: FakeFfmpegProcess[];
  readonly progressQueues: ByteQueue[];
};

export type ConcreteSupervisorFixture = {
  readonly supervisor: Supervisor;
  readonly mediaService: MediaMtxService;
  readonly mediaProcess: FakeMediaMtxProcess;
  readonly mediaSpawner: FakeMediaMtxSpawner;
  readonly mediaArtifact: FakeArtifact;
  readonly mediaCredential: FakeCredential;
  readonly scheduler: ManualClockScheduler;
  readonly tracker: ActivePipelineTracker;
  readonly courts: Four<CourtFfmpegFixture>;
  readonly pipelines: Four<FfmpegCourtPipeline>;
  readonly pipelineOptions: Four<FfmpegCourtPipelineOptions>;
};

type CourtFixtureInput = {
  readonly slot: CourtSlot;
  readonly config: LocalMediaRuntimeConfig;
  readonly scheduler: ManualClockScheduler;
  readonly mediaService: MediaMtxService;
  readonly tracker: ActivePipelineTracker;
};

function allOnlineSnapshot(): MediaMtxPathsSnapshot {
  return Object.freeze({
    itemCount: PATHS.length,
    pageCount: 1,
    items: Object.freeze(PATHS.map((name) => Object.freeze({ name, available: true, online: true }))),
  });
}

function createCourtFixture(input: CourtFixtureInput): CourtFfmpegFixture {
  const progressQueue = new ByteQueue();
  const process = new FakeFfmpegProcess(progressQueue);
  const spawner = new FakeFfmpegSpawner(process, input.tracker);
  const options: FfmpegCourtPipelineOptions = {
    config: input.config,
    courtId: itemAt(input.config.courtIds, input.slot),
    spawner,
    scheduler: input.scheduler,
    clock: input.scheduler,
    mediaInspector: input.mediaService,
    overlayFactory: null,
  };
  return {
    pipeline: new FfmpegCourtPipeline(options),
    options,
    spawner,
    processes: [process],
    progressQueues: [progressQueue],
  };
}

export async function createConcreteSupervisorFixture(): Promise<ConcreteSupervisorFixture> {
  const config = mediaConfig(COURT_IDS, VIDEO_DEVICE_IDS);
  const scheduler = new ManualClockScheduler();
  const tracker = new ActivePipelineTracker();
  const mediaProcess = new FakeMediaMtxProcess();
  const mediaSpawner = new FakeMediaMtxSpawner(mediaProcess);
  const mediaArtifact = new FakeArtifact();
  const mediaCredential = new FakeCredential();
  const mediaClient = new FakeApiClient(Array.from({ length: 40 }, allOnlineSnapshot));
  const mediaService = new MediaMtxService({
    config,
    runtimeFiles: new FakeRuntimeFiles(mediaArtifact),
    spawner: mediaSpawner,
    scheduler,
    credentialFactory: { create: () => mediaCredential },
    apiClientFactory: { create: () => mediaClient },
  });
  await mediaService.start();
  const shared = { config, scheduler, mediaService, tracker };
  const courts = [
    createCourtFixture({ ...shared, slot: 0 }),
    createCourtFixture({ ...shared, slot: 1 }),
    createCourtFixture({ ...shared, slot: 2 }),
    createCourtFixture({ ...shared, slot: 3 }),
  ] as const;
  for (const court of courts) court.progressQueues[0]?.push(progress(1));
  const pipelines = [
    courts[0].pipeline,
    courts[1].pipeline,
    courts[2].pipeline,
    courts[3].pipeline,
  ] as const;
  const pipelineOptions = [
    courts[0].options,
    courts[1].options,
    courts[2].options,
    courts[3].options,
  ] as const;
  return {
    supervisor: new Supervisor(agentConfig(), pipelines),
    mediaService,
    mediaProcess,
    mediaSpawner,
    mediaArtifact,
    mediaCredential,
    scheduler,
    tracker,
    courts,
    pipelines,
    pipelineOptions,
  };
}

export function prepareNextGeneration(
  fixture: ConcreteSupervisorFixture,
  slot: CourtSlot,
): FakeFfmpegProcess {
  const court = fixture.courts[slot];
  const progressQueue = new ByteQueue();
  const process = new FakeFfmpegProcess(progressQueue);
  court.progressQueues.push(progressQueue);
  court.processes.push(process);
  court.spawner.process = process;
  progressQueue.push(progress(1));
  return process;
}

function snapshot(slot: CourtSlot, lifecycle: Lifecycle = 'running') {
  const base = courtSnapshot(slot, lifecycle);
  return {
    ...base,
    desired: {
      ...base.desired,
      desired: {
        ...base.desired.desired,
        profile: { ...base.desired.desired.profile, overlayEnabled: false },
      },
    },
  };
}

export function activeSnapshots() {
  return [snapshot(0), snapshot(1), snapshot(2), snapshot(3)] as const;
}

export function secondCourtStoppedSnapshots() {
  return [snapshot(0), snapshot(1, 'stopped'), snapshot(2), snapshot(3)] as const;
}
