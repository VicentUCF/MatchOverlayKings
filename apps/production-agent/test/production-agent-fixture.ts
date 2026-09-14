export const COURT_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
] as const;

export function productionEnvironment(): Readonly<Record<string, string>> {
  return {
    KPL_AGENT_COURT_IDS: COURT_IDS.join(','),
    KPL_AGENT_MAX_CONCURRENT_PIPELINES: '3',
    KPL_AGENT_SUPABASE_URL: 'https://project.supabase.co',
    KPL_AGENT_SUPABASE_PUBLISHABLE_KEY: 'publishable-example',
    KPL_AGENT_ACCESS_TOKEN: 'agent-access-example',
    KPL_AGENT_SECRET_ROOT: '/var/lib/kpl-agent/secrets',
    KPL_AGENT_POLL_INTERVAL_MS: '1000',
    KPL_AGENT_SHUTDOWN_DEADLINE_MS: '30000',
  };
}

export function productionMediaConfig(courtIds: readonly string[] = COURT_IDS) {
  return {
    courtIds,
    mediaMtxVersion: '1.21.0',
    mediaMtxExecutablePath: '/opt/kpl/bin/mediamtx',
    ffmpegExecutablePath: '/opt/kpl/bin/ffmpeg',
    runtimeDirectoryPath: '/run/user/1000/kpl-agent',
    runtimeDirectoryMode: 0o700,
    configFileMode: 0o600,
    persistence: 'ephemeral',
    startupTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    stopGraceMs: 2_000,
    bindings: {
      apiHost: '127.0.0.1',
      apiPort: 9997,
      srtHost: '127.0.0.1',
      srtPort: 8890,
      courts: courtIds.map((courtId, index) => ({ courtId, pathName: `court-${index + 1}` })),
      videoInputs: [{
        deviceId: '20000000-0000-4000-8000-000000000001',
        kind: 'v4l2',
        devicePath: '/dev/video0',
        inputPixelFormat: 'yuyv422',
      }],
      audioInputs: [],
    },
  } as const;
}
