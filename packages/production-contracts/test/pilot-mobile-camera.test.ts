import { describe, expect, it } from 'vitest';
import {
  PilotMobileCameraSessionSchema,
  PilotMobileCameraStatusReportSchema,
  PilotMobileVideoProfileSchema,
  PilotSessionStatusSchema,
  PilotSourceSchema,
  UpdatePilotMobileCameraDesiredInputSchema,
} from '../src/index.js';

const sessionId = '10000000-0000-4000-8000-000000000001';
const clientId = '20000000-0000-4000-8000-000000000001';
const now = '2026-09-14T12:00:00.000Z';

describe('pilot mobile camera contracts', () => {
  it('accepts every supported profile, mobile source and reconnecting output state', () => {
    for (const profile of ['720p30', '720p60', '1080p30', '1080p60']) {
      expect(PilotMobileVideoProfileSchema.parse(profile)).toBe(profile);
    }
    expect(PilotSourceSchema.parse({ id: 'mobile:pilot', kind: 'mobile', label: 'Android' }).kind).toBe('mobile');
    expect(PilotSessionStatusSchema.parse('reconnecting')).toBe('reconnecting');
  });

  it('validates revisions, applied settings and bounded WebRTC metrics', () => {
    const parsed = PilotMobileCameraSessionSchema.parse({
      id: sessionId,
      courtSlug: 'pista-1',
      state: 'ready',
      desired: { revision: 2, cameraId: 'rear', profile: '1080p30', audioEnabled: true },
      capabilities: {
        cameras: [{
          id: 'rear', label: 'Trasera', facingMode: 'environment', maxWidth: 3840, maxHeight: 2160,
          maxFramesPerSecond: 60, supportedProfiles: ['720p30', '720p60', '1080p30', '1080p60'],
        }],
        audioAvailable: true,
      },
      applied: {
        revision: 2, cameraId: 'rear', profile: '1080p30', audioEnabled: true,
        width: 1920, height: 1080, framesPerSecond: 29.97,
      },
      metrics: { bitrateKbps: 6200, packetLossPercent: 0.2, roundTripTimeMs: 24 },
      claimed: true,
      lastHeartbeatAt: now,
      expiresAt: '2026-09-15T00:00:00.000Z',
      error: null,
      previewUrl: 'http://127.0.0.1:8889/mobile-pilot/whep',
    });

    expect(parsed.applied?.framesPerSecond).toBe(29.97);
    expect(parsed.metrics?.roundTripTimeMs).toBe(24);
    expect(UpdatePilotMobileCameraDesiredInputSchema.safeParse({
      expectedRevision: 0, cameraId: 'rear', profile: '1080p30', audioEnabled: true,
    }).success).toBe(false);
    expect(PilotMobileCameraStatusReportSchema.safeParse({
      clientId, state: 'ready', applied: null,
      metrics: { bitrateKbps: 1, packetLossPercent: 101, roundTripTimeMs: 2 }, error: null,
    }).success).toBe(false);
  });

  it('rejects unknown fields at every mobile API boundary', () => {
    expect(UpdatePilotMobileCameraDesiredInputSchema.safeParse({
      expectedRevision: 1, cameraId: 'rear', profile: '720p30', audioEnabled: false, zoom: 2,
    }).success).toBe(false);
    expect(PilotMobileCameraStatusReportSchema.safeParse({
      clientId, state: 'ready', applied: null, metrics: null, error: null, torch: true,
    }).success).toBe(false);
  });
});
