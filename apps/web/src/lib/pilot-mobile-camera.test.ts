import { describe, expect, it, vi } from 'vitest';
import { parsePilotMobileLink, profileDimensions, WhepPreview } from './pilot-mobile-camera.js';

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

describe('camera monitor lifecycle', () => {
  it('reports a lost connection and releases the decoder before remote cleanup completes', async () => {
    class Peer extends EventTarget {
      connectionState = 'new';
      iceGatheringState = 'complete';
      localDescription = { type: 'offer', sdp: 'fixture-offer' };
      addTransceiver = vi.fn();
      createOffer = async () => this.localDescription;
      setLocalDescription = async () => undefined;
      setRemoteDescription = async () => undefined;
      close = vi.fn(() => { this.connectionState = 'closed'; });
    }
    const peer = new Peer();
    let finishCleanup: ((response: Response) => void) | undefined;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === 'DELETE'
      ? new Promise<Response>((resolve) => { finishCleanup = resolve; })
      : new Response('fixture-answer', { status: 201, headers: { location: '/camera/session' } }));
    vi.stubGlobal('RTCPeerConnection', class { constructor() { return peer; } });
    vi.stubGlobal('fetch', fetch);
    try {
      const connectionChanged = vi.fn();
      const preview = new WhepPreview('http://127.0.0.1:8889/camera/whep', vi.fn(), connectionChanged);
      await preview.connect(new AbortController().signal);
      peer.connectionState = 'disconnected';
      peer.dispatchEvent(new Event('connectionstatechange'));
      expect(connectionChanged).toHaveBeenCalledWith('disconnected');
      const closing = preview.close();
      expect(peer.close).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:8889/camera/session', expect.objectContaining({ method: 'DELETE' }));
      finishCleanup?.(new Response(null, { status: 204 }));
      await closing;
    } finally { vi.unstubAllGlobals(); }
  });
});
