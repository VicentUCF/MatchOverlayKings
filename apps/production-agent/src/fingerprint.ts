import { createHash } from 'node:crypto';
import type { CourtProgramProfile } from '@kpl/production-contracts';
import { ProfileFingerprintSchema, type ProfileFingerprint } from './models.js';

export function fingerprintProfile(profile: CourtProgramProfile): ProfileFingerprint {
  const canonicalProfile = [
    profile.courtId,
    profile.videoSourceDeviceId,
    profile.width,
    profile.height,
    profile.framesPerSecond,
    profile.videoBitrateKbps,
    profile.audioSourceDeviceId,
    profile.audioBitrateKbps,
    profile.overlayEnabled,
  ];
  const digest = createHash('sha256').update(JSON.stringify(canonicalProfile)).digest('hex');
  return ProfileFingerprintSchema.parse(digest);
}
