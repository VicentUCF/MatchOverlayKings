export const OUTPUT_ID = '10000000-0000-4000-8000-000000000001';
export const EVENT_ID = '20000000-0000-4000-8000-000000000001';
export const CLUB_ID = '30000000-0000-4000-8000-000000000001';
export const COURT_ID = '40000000-0000-4000-8000-000000000001';
export const VIDEO_DEVICE_ID = '50000000-0000-4000-8000-000000000001';
export const AUDIO_DEVICE_ID = '60000000-0000-4000-8000-000000000001';
export const PRINCIPAL_ID = '70000000-0000-4000-8000-000000000001';

export function profile() {
  return {
    courtId: COURT_ID,
    videoSourceDeviceId: VIDEO_DEVICE_ID,
    width: 1920,
    height: 1080,
    framesPerSecond: 60,
    videoBitrateKbps: 8_000,
    audioSourceDeviceId: AUDIO_DEVICE_ID,
    audioBitrateKbps: 192,
    overlayEnabled: true,
  };
}

export function reconcileInput() {
  return {
    output: {
      id: OUTPUT_ID,
      eventId: EVENT_ID,
      clubId: CLUB_ID,
      courtId: COURT_ID,
      name: ' Court program ',
      kind: 'program',
      transport: 'srt',
      enabled: true,
      version: 1,
    },
    desired: {
      outputId: OUTPUT_ID,
      clubId: CLUB_ID,
      eventId: EVENT_ID,
      version: 3,
      desired: {
        lifecycle: 'running',
        profile: profile(),
      },
      updatedAt: '2026-09-10T07:00:00Z',
      updatedByPrincipalId: PRINCIPAL_ID,
      commandId: 'command-3',
    },
    observed: {
      outputId: OUTPUT_ID,
      clubId: CLUB_ID,
      eventId: EVENT_ID,
      agentPrincipalId: PRINCIPAL_ID,
      sequence: 8,
      health: 'healthy',
      state: {},
      reportedAt: '2026-09-10T07:01:00Z',
    },
    runtime: null,
  };
}

export function runtime(profileFingerprint: string, appliedDesiredVersion = 3) {
  return {
    outputId: OUTPUT_ID,
    appliedDesiredVersion,
    profileFingerprint,
  };
}
