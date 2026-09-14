export const COURT_IDS = [
  '41000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000002',
  '41000000-0000-4000-8000-000000000003',
  '41000000-0000-4000-8000-000000000004',
] as const;

export const OUTPUT_IDS = [
  '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002',
  '11000000-0000-4000-8000-000000000003',
  '11000000-0000-4000-8000-000000000004',
] as const;

const EVENT_IDS = [
  '21000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000002',
  '21000000-0000-4000-8000-000000000003',
  '21000000-0000-4000-8000-000000000004',
] as const;

export const VIDEO_DEVICE_IDS = [
  '51000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',
  '51000000-0000-4000-8000-000000000003',
  '51000000-0000-4000-8000-000000000004',
] as const;

const CLUB_ID = '31000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = '71000000-0000-4000-8000-000000000001';

export type CourtSlot = 0 | 1 | 2 | 3;
export type Lifecycle = 'off' | 'preflight' | 'running' | 'stopped';

export function agentConfig() {
  return {
    courts: [
      { courtId: COURT_IDS[0] },
      { courtId: COURT_IDS[1] },
      { courtId: COURT_IDS[2] },
      { courtId: COURT_IDS[3] },
    ],
    maxConcurrentPipelines: 3,
  };
}

export function courtSnapshot(slot: CourtSlot, lifecycle: Lifecycle = 'running') {
  const courtId = COURT_IDS[slot];
  const outputId = OUTPUT_IDS[slot];
  const eventId = EVENT_IDS[slot];
  return {
    output: {
      id: outputId,
      eventId,
      clubId: CLUB_ID,
      courtId,
      name: `Court ${slot + 1}`,
      kind: 'program',
      transport: 'srt',
      enabled: true,
      version: 1,
    },
    desired: {
      outputId,
      clubId: CLUB_ID,
      eventId,
      version: 1,
      desired: {
        lifecycle,
        profile: {
          courtId,
          videoSourceDeviceId: VIDEO_DEVICE_IDS[slot],
          width: 1920,
          height: 1080,
          framesPerSecond: 60,
          videoBitrateKbps: 8_000,
          audioSourceDeviceId: null,
          audioBitrateKbps: 192,
          overlayEnabled: true,
        },
      },
      updatedAt: '2026-09-10T08:00:00Z',
      updatedByPrincipalId: PRINCIPAL_ID,
      commandId: `court-${slot + 1}-command`,
    },
    observed: {
      outputId,
      clubId: CLUB_ID,
      eventId,
      agentPrincipalId: PRINCIPAL_ID,
      sequence: 1,
      health: 'healthy',
      state: {},
      reportedAt: '2026-09-10T08:01:00Z',
    },
  };
}

export function runningSnapshots() {
  return [courtSnapshot(0), courtSnapshot(1), courtSnapshot(2), courtSnapshot(3)] as const;
}
