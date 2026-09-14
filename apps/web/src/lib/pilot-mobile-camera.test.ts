import { describe, expect, it } from 'vitest';
import { parsePilotMobileLink, profileDimensions } from './pilot-mobile-camera.js';

const session = '10000000-0000-4000-8000-000000000001';
const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('pilot mobile camera link', () => {
  it('reads a fragment-only secret for a private LAN endpoint', () => {
    const hash = `#endpoint=${encodeURIComponent('http://192.168.1.20:4310')}&session=${session}&token=${token}`;
    expect(parsePilotMobileLink(hash)).toEqual({ endpoint: 'http://192.168.1.20:4310', sessionId: session, token });
  });

  it('rejects public, credentialed, HTTPS and malformed endpoints', () => {
    for (const endpoint of [
      'http://example.com:4310',
      'http://user:pass@192.168.1.20:4310',
      'https://192.168.1.20:4310',
      'http://192.168.1.20:4310/unexpected',
    ]) {
      const hash = `#endpoint=${encodeURIComponent(endpoint)}&session=${session}&token=${token}`;
      expect(parsePilotMobileLink(hash)).toBeNull();
    }
  });

  it('accepts private IPv6 but rejects non-LAN IPv6 destinations', () => {
    const local = `#endpoint=${encodeURIComponent('http://[fd12::20]:4310')}&session=${session}&token=${token}`;
    const publicAddress = `#endpoint=${encodeURIComponent('http://[2001:db8::20]:4310')}&session=${session}&token=${token}`;
    expect(parsePilotMobileLink(local)?.endpoint).toBe('http://[fd12::20]:4310');
    expect(parsePilotMobileLink(publicAddress)).toBeNull();
  });

  it('maps all declared profiles to exact capture targets', () => {
    expect(profileDimensions('720p60')).toEqual({ width: 1280, height: 720, framesPerSecond: 60 });
    expect(profileDimensions('1080p30')).toEqual({ width: 1920, height: 1080, framesPerSecond: 30 });
  });
});
