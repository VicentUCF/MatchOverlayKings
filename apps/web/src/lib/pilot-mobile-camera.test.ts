import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimPilotMobileCamera, parsePilotMobileLink, profileDimensions, WhepPreview } from './pilot-mobile-camera.js';

const session = '10000000-0000-4000-8000-000000000001';
const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('mobile camera ownership recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const link = { endpoint: 'http://192.168.1.20:4310', sessionId: session, token };
  const clientId = '20000000-0000-4000-8000-000000000001';
  const capabilities = { cameras: [], audioAvailable: false };
  const claimed = { desired: { revision: 2, cameraId: 'rear', profile: '720p30', audioEnabled: false },
    whipUrl: `${link.endpoint}/camera/whip`, whipUser: 'camera' };
  function setup(code = 'CONFLICT') {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ error: { code, message: 'Enlace ocupado' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('retries until the previous page reservation expires without changing identity', async () => {
    const fetch = setup();
    const retry = vi.fn();
    const pending = claimPilotMobileCamera(link, clientId, capabilities, new AbortController().signal, retry);
    await vi.advanceTimersByTimeAsync(20_000);
    fetch.mockResolvedValueOnce(Response.json(claimed));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(claimed);
    expect(retry).toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, init]) => JSON.parse(init.body as string).clientId === clientId)).toBe(true);
  });

  it('stops retrying when another camera remains active', async () => {
    const fetch = setup();
    const pending = claimPilotMobileCamera(link, clientId, capabilities, new AbortController().signal, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
    await vi.advanceTimersByTimeAsync(22_000);
    await rejected;
    const attempts = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(attempts);
  });

  it('cancels pending retries when the page closes', async () => {
    const fetch = setup();
    const controller = new AbortController();
    const pending = claimPilotMobileCamera(link, clientId, capabilities, controller.signal, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(22_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['EXPIRED', 'FORBIDDEN', 'NOT_READY'])('does not retry %s failures', async (code) => {
    const fetch = setup(code);
    await expect(claimPilotMobileCamera(link, clientId, capabilities, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

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
      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8889/camera/whep', expect.objectContaining({
        method: 'POST', targetAddressSpace: 'loopback',
      }));
      peer.connectionState = 'disconnected';
      peer.dispatchEvent(new Event('connectionstatechange'));
      expect(connectionChanged).toHaveBeenCalledWith('disconnected');
      const closing = preview.close();
      expect(peer.close).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:8889/camera/session', expect.objectContaining({ method: 'DELETE', targetAddressSpace: 'loopback' }));
      finishCleanup?.(new Response(null, { status: 204 }));
      await closing;
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ['http://localhost:8889', 'loopback'],
    ['http://[::1]:8889', 'loopback'],
    ['http://127.2.3.4:8889', 'loopback'],
    ['http://192.168.1.20:8889', 'local'],
    ['http://[fd12::20]:8889', 'local'],
    ['http://127.camera.example:8889', 'local'],
  ])('declares the correct address space for %s', async (origin, space) => {
    vi.stubGlobal('RTCPeerConnection', class extends EventTarget {
      iceGatheringState = 'complete';
      localDescription = { type: 'offer', sdp: 'fixture-offer' };
      addTransceiver() {}
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
    });
    const fetch = vi.fn(async () => new Response('fixture-answer', { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const preview = new WhepPreview(`${origin}/camera/whep`, vi.fn());
    try {
      await preview.connect(new AbortController().signal);
      expect(fetch).toHaveBeenCalledWith(`${origin}/camera/whep`, expect.objectContaining({ targetAddressSpace: space }));
      fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(preview.connect(new AbortController().signal)).rejects.toThrow('La cámara puede seguir conectada');
    } finally { await preview.close(); vi.unstubAllGlobals(); }
  });
});
