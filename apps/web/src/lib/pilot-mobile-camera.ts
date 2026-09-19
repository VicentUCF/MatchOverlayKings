import { mobileClientIdentity } from './pilot-mobile-identity.js';
import {
  ClaimPilotMobileCameraResponseSchema,
  PilotMobileCameraDesiredSchema,
  PilotMobileCameraSessionSchema,
  type PilotMobileCameraApplied,
  type PilotMobileCameraCapabilities,
  type PilotMobileCameraDesired,
  type PilotMobileCameraMetrics,
  type PilotMobileCameraState,
  type PilotMobileVideoProfile,
} from '@kpl/production-contracts';

export type PilotMobileLink = {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly token: string;
};

export type PilotMobileRuntimeSnapshot = {
  readonly state: PilotMobileCameraState;
  readonly desired: PilotMobileCameraDesired | null;
  readonly applied: PilotMobileCameraApplied | null;
  readonly metrics: PilotMobileCameraMetrics | null;
  readonly wakeLockActive: boolean;
  readonly error: string | null;
};

export class PilotMobileApiError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PilotMobileApiError';
  }
}

type RuntimeCallbacks = {
  readonly onStream: (stream: MediaStream | null) => void;
  readonly onSnapshot: (snapshot: PilotMobileRuntimeSnapshot) => void;
};

type WakeLockSentinelLike = EventTarget & { readonly released: boolean; release: () => Promise<void> };
type NavigatorWithWakeLock = Navigator & {
  readonly wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
};

const PROFILE_DIMENSIONS: Readonly<Record<PilotMobileVideoProfile, {
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
}>> = {
  '720p30': { width: 1280, height: 720, framesPerSecond: 30 },
  '720p60': { width: 1280, height: 720, framesPerSecond: 60 },
  '1080p30': { width: 1920, height: 1080, framesPerSecond: 30 },
  '1080p60': { width: 1920, height: 1080, framesPerSecond: 60 },
};

const PROFILE_ORDER = ['720p30', '720p60', '1080p30', '1080p60'] as const;

export function parsePilotMobileLink(hash: string): PilotMobileLink | null {
  const parameters = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const endpointValue = parameters.get('endpoint');
  const sessionId = parameters.get('session');
  const token = parameters.get('token');
  if (endpointValue === null || sessionId === null || token === null
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
    || token.length < 32 || token.length > 128) return null;
  try {
    const endpoint = new URL(endpointValue);
    if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || !isLocalHost(endpoint.hostname)) return null;
    return { endpoint: endpoint.origin, sessionId, token };
  } catch {
    return null;
  }
}

export function profileDimensions(profile: PilotMobileVideoProfile) {
  return PROFILE_DIMENSIONS[profile];
}

export class PilotMobileCameraRuntime {
  private readonly clientId: string;
  private readonly abortController = new AbortController();
  private desired: PilotMobileCameraDesired | null = null;
  private applied: PilotMobileCameraApplied | null = null;
  private metrics: PilotMobileCameraMetrics | null = null;
  private stream: MediaStream | null = null;
  private publisher: WhipPublisher | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;
  private reportTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private audioAvailable = false;
  private applying = false;
  private state: PilotMobileCameraState = 'waiting_permission';
  private error: string | null = null;
  private previousOutbound: { readonly bytes: number; readonly at: number } | null = null;

  public constructor(
    private readonly link: PilotMobileLink,
    private readonly callbacks: RuntimeCallbacks,
  ) { this.clientId = mobileClientIdentity(link.endpoint, link.sessionId); }

  public async prepare(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      throw new Error('Este navegador no ofrece cámara WebRTC. Usa Chrome Android actualizado.');
    }
    this.setState('connecting');
    const capabilities = await discoverCapabilities();
    this.audioAvailable = capabilities.audioAvailable;
    const claim = await localJson(
      `${this.link.endpoint}/api/pilot/mobile-camera/${encodeURIComponent(this.link.sessionId)}/claim`,
      {
        method: 'POST',
        headers: mobileHeaders(this.link.token),
        body: JSON.stringify({ clientId: this.clientId, capabilities }),
        signal: this.abortController.signal,
      },
      ClaimPilotMobileCameraResponseSchema,
    );
    this.desired = claim.desired;
    await this.applyDesired(claim.desired, claim.whipUrl, claim.whipUser);
    void this.desiredLoop(claim.whipUrl, claim.whipUser);
    this.reportTimer = window.setInterval(() => { void this.sendStatus(); }, 2_000);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    await this.acquireWakeLock();
    await this.sendStatus();
  }

  public async stop(): Promise<void> {
    this.abortController.abort();
    if (this.reportTimer !== null) window.clearInterval(this.reportTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    await this.publisher?.close();
    this.publisher = null;
    stopStream(this.stream);
    this.stream = null;
    this.callbacks.onStream(null);
    await this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void this.acquireWakeLock();
      if (this.state === 'degraded' && this.error === 'Mantén esta página visible durante el partido.') {
        this.error = null;
        this.setState('ready');
      }
      return;
    }
    this.error = 'Mantén esta página visible durante el partido.';
    this.setState('degraded');
  };

  private async desiredLoop(whipUrl: string, whipUser: string): Promise<void> {
    while (!this.abortController.signal.aborted) {
      const desired = this.desired;
      if (desired !== null && this.applied?.revision !== desired.revision) {
        try {
          await this.applyDesired(desired, whipUrl, whipUser);
        } catch {
          if (this.abortController.signal.aborted) return;
          await delay(2_000, this.abortController.signal).catch(() => undefined);
        }
        continue;
      }
      try {
        const response = await localJson(
          `${this.link.endpoint}/api/pilot/mobile-camera/${encodeURIComponent(this.link.sessionId)}/desired?after=${this.desired?.revision ?? 0}`,
          { headers: mobileHeaders(this.link.token), signal: this.abortController.signal },
          PilotMobileCameraDesiredEnvelopeSchema,
        );
        if (response.desired.revision !== this.desired?.revision) {
          this.desired = response.desired;
        }
      } catch (error) {
        if (this.abortController.signal.aborted) return;
        if (error instanceof PilotMobileApiError && error.code === 'EXPIRED') {
          this.error = error.message;
          this.setState('revoked');
          await this.stop();
          return;
        }
        this.error = errorMessage(error);
        this.setState('reconnecting');
        await delay(2_000, this.abortController.signal).catch(() => undefined);
      }
    }
  }

  private async applyDesired(
    desired: PilotMobileCameraDesired,
    whipUrl: string,
    whipUser: string,
  ): Promise<void> {
    if (desired.cameraId === null) throw new Error('El panel todavía no ha seleccionado una cámara.');
    this.applying = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setState('connecting');
    try {
      await this.publisher?.close();
      this.publisher = null;
      stopStream(this.stream);
      const dimensions = profileDimensions(desired.profile);
      const stream = await openStream(desired.cameraId, dimensions, this.audioAvailable, desired.audioEnabled);
      const video = stream.getVideoTracks()[0];
      if (video === undefined) throw new Error('El móvil no devolvió una pista de vídeo.');
      video.contentHint = 'motion';
      for (const audio of stream.getAudioTracks()) audio.enabled = desired.audioEnabled;
      this.stream = stream;
      this.callbacks.onStream(stream);
      const publisher = new WhipPublisher(whipUrl, `${whipUser}:${this.link.token}`, stream, (connection) => {
        if ((connection === 'failed' || connection === 'disconnected') && !this.applying) this.scheduleReconnect(whipUrl, whipUser);
      });
      this.publisher = publisher;
      await publisher.connect(this.abortController.signal);
      const settings = video.getSettings();
      this.applied = {
        revision: desired.revision,
        cameraId: desired.cameraId,
        profile: desired.profile,
        audioEnabled: desired.audioEnabled,
        width: settings.width ?? dimensions.width,
        height: settings.height ?? dimensions.height,
        framesPerSecond: settings.frameRate ?? dimensions.framesPerSecond,
      };
      this.previousOutbound = null;
      this.reconnectAttempt = 0;
      this.error = null;
      this.setState(appliedMatches(desired, this.applied) ? 'ready' : 'degraded');
    } catch (error) {
      this.error = errorMessage(error);
      this.setState('error');
      throw error;
    } finally {
      this.applying = false;
    }
  }

  private scheduleReconnect(whipUrl: string, whipUser: string): void {
    if (this.reconnectTimer !== null || this.abortController.signal.aborted || this.stream === null) return;
    this.error = 'Se perdió la conexión con producción. Reintentando…';
    this.setState('reconnecting');
    const delays = [1_000, 2_000, 4_000, 8_000] as const;
    const delayMs = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(whipUrl, whipUser);
    }, delayMs);
  }

  private async reconnect(whipUrl: string, whipUser: string): Promise<void> {
    if (this.stream === null || this.abortController.signal.aborted) return;
    try {
      await this.publisher?.close();
      const publisher = new WhipPublisher(whipUrl, `${whipUser}:${this.link.token}`, this.stream, (connection) => {
        if (connection === 'failed' || connection === 'disconnected') this.scheduleReconnect(whipUrl, whipUser);
      });
      this.publisher = publisher;
      await publisher.connect(this.abortController.signal);
      this.reconnectAttempt = 0;
      this.error = null;
      this.setState(this.desired !== null && this.applied !== null && appliedMatches(this.desired, this.applied)
        ? 'ready' : 'degraded');
    } catch {
      this.scheduleReconnect(whipUrl, whipUser);
    }
  }

  private async sendStatus(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    this.metrics = await this.sampleMetrics();
    this.emit();
    try {
      await localJson(
        `${this.link.endpoint}/api/pilot/mobile-camera/${encodeURIComponent(this.link.sessionId)}/status`,
        {
          method: 'POST',
          headers: mobileHeaders(this.link.token),
          body: JSON.stringify({
            clientId: this.clientId,
            state: reportableState(this.state),
            applied: this.applied,
            metrics: this.metrics,
            error: this.error,
          }),
          signal: this.abortController.signal,
        },
        PilotMobileCameraStatusEnvelopeSchema,
      );
    } catch (error) {
      if (error instanceof PilotMobileApiError && error.code === 'EXPIRED') {
        this.error = error.message;
        this.setState('revoked');
        await this.stop();
      }
      // A failed heartbeat is reflected by server-side staleness; the media retry owns recovery.
    }
  }

  private async sampleMetrics(): Promise<PilotMobileCameraMetrics | null> {
    const peer = this.publisher?.peer();
    if (peer === null || peer === undefined) return null;
    try {
      const stats = await peer.getStats();
      let bytes = 0;
      let packetLoss: number | null = null;
      let roundTripTime: number | null = null;
      stats.forEach((entry) => {
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
          bytes += Number(entry.bytesSent ?? 0);
          const measuredFps = Number(entry.framesPerSecond);
          if (this.applied !== null && Number.isFinite(measuredFps) && measuredFps >= 0) {
            this.applied = { ...this.applied, framesPerSecond: measuredFps };
          }
        }
        if (entry.type === 'remote-inbound-rtp' && entry.kind === 'video') {
          const fractionLost = Number(entry.fractionLost);
          const lost = Number(entry.packetsLost ?? 0);
          const received = Number(entry.packetsReceived ?? 0);
          packetLoss = Number.isFinite(fractionLost)
            ? Math.max(0, fractionLost * 100)
            : lost + received > 0 ? Math.max(0, (lost / (lost + received)) * 100) : null;
          roundTripTime = Number.isFinite(Number(entry.roundTripTime)) ? Number(entry.roundTripTime) * 1_000 : null;
        }
      });
      const now = performance.now();
      const previous = this.previousOutbound;
      this.previousOutbound = { bytes, at: now };
      const bitrateKbps = previous === null || now <= previous.at
        ? 0
        : Math.max(0, ((bytes - previous.bytes) * 8) / (now - previous.at));
      return { bitrateKbps, packetLossPercent: packetLoss, roundTripTimeMs: roundTripTime };
    } catch {
      return null;
    }
  }

  private async acquireWakeLock(): Promise<void> {
    const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
    if (wakeLock === undefined || document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
        this.emit();
      }, { once: true });
      this.emit();
    } catch {
      this.wakeLock = null;
      this.emit();
    }
  }

  private setState(state: PilotMobileCameraState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.callbacks.onSnapshot({
      state: this.state,
      desired: this.desired,
      applied: this.applied,
      metrics: this.metrics,
      wakeLockActive: this.wakeLock !== null && !this.wakeLock.released,
      error: this.error,
    });
  }
}

export class WhepPreview {
  private peerConnection: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;

  public constructor(
    private readonly url: string,
    private readonly onStream: (stream: MediaStream) => void,
    private readonly onConnection?: (state: RTCPeerConnectionState) => void,
  ) {}

  public async connect(signal: AbortSignal): Promise<void> {
    await this.close();
    const peer = new RTCPeerConnection();
    this.peerConnection = peer;
    peer.addEventListener('connectionstatechange', () => this.onConnection?.(peer.connectionState));
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.addEventListener('track', (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.onStream(stream);
    });
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, signal);
    const offerSdp = peer.localDescription?.sdp;
    if (offerSdp === undefined) throw new Error('No se pudo crear la oferta WebRTC del preview.');
    let response: Response;
    try {
      response = await localFetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: offerSdp,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('No se puede acceder a la vista previa. Revisa CORS, el permiso de red local del navegador y la conexión con el PC. La cámara puede seguir conectada.');
    }
    if (!response.ok) throw new Error(`La vista previa ha sido rechazada (HTTP ${response.status}). Comprueba el acceso al servicio de cámaras.`);
    this.resourceUrl = resourceUrl(this.url, response.headers.get('location'));
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  }

  public async close(): Promise<void> {
    this.peerConnection?.close();
    this.peerConnection = null;
    const resource = this.resourceUrl;
    this.resourceUrl = null;
    if (resource !== null) {
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), 2_000);
      try { await localFetch(resource, { method: 'DELETE', signal: controller.signal }); }
      catch { /* The local decoder is already closed, even if the camera service is offline. */ }
      finally { globalThis.clearTimeout(timer); }
    }
  }
}

class WhipPublisher {
  private peerConnection: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;

  public constructor(
    private readonly url: string,
    private readonly bearer: string,
    private readonly stream: MediaStream,
    private readonly onConnection: (state: RTCPeerConnectionState) => void,
  ) {}

  public peer(): RTCPeerConnection | null {
    return this.peerConnection;
  }

  public async connect(signal: AbortSignal): Promise<void> {
    const peer = new RTCPeerConnection();
    this.peerConnection = peer;
    for (const track of this.stream.getTracks()) peer.addTrack(track, this.stream);
    peer.addEventListener('connectionstatechange', () => this.onConnection(peer.connectionState));
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, signal);
    const offerSdp = peer.localDescription?.sdp;
    if (offerSdp === undefined) throw new Error('No se pudo crear la oferta WebRTC de la cámara.');
    const response = await localFetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.bearer}`, 'content-type': 'application/sdp' },
      body: offerSdp,
      signal,
    });
    if (!response.ok) throw new Error(`MediaMTX rechazó la cámara (${response.status}).`);
    this.resourceUrl = resourceUrl(this.url, response.headers.get('location'));
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  }

  public async close(): Promise<void> {
    const resource = this.resourceUrl;
    this.resourceUrl = null;
    if (resource !== null) {
      await localFetch(resource, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.bearer}` },
      }).catch(() => undefined);
    }
    this.peerConnection?.close();
    this.peerConnection = null;
  }
}

const PilotMobileCameraDesiredEnvelopeSchema = {
  parse(input: unknown) {
    if (typeof input !== 'object' || input === null || !('desired' in input)) throw new TypeError('Invalid desired response');
    return { desired: PilotMobileCameraDesiredSchema.parse(input.desired) };
  },
};
const PilotMobileCameraStatusEnvelopeSchema = {
  parse(input: unknown) {
    if (typeof input !== 'object' || input === null || !('mobileCamera' in input)) throw new TypeError('Invalid status response');
    return { mobileCamera: PilotMobileCameraSessionSchema.parse(input.mobileCamera) };
  },
};

async function discoverCapabilities(): Promise<PilotMobileCameraCapabilities> {
  const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stopStream(permissionStream);
  let audioAvailable = false;
  try {
    const audio = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    audioAvailable = audio.getAudioTracks().length > 0;
    stopStream(audio);
  } catch {
    audioAvailable = false;
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(({ kind }) => kind === 'videoinput');
  const cameras = [];
  for (const [index, device] of devices.entries()) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: device.deviceId } },
        audio: false,
      });
      const track = probe.getVideoTracks()[0];
      if (track === undefined) {
        stopStream(probe);
        continue;
      }
      const capabilities = track.getCapabilities();
      const maxWidth = numericMaximum(capabilities.width);
      const maxHeight = numericMaximum(capabilities.height);
      const maxFramesPerSecond = numericMaximum(capabilities.frameRate);
      const supportedProfiles: PilotMobileVideoProfile[] = [];
      for (const profile of PROFILE_ORDER) {
        const target = profileDimensions(profile);
        if ((maxWidth !== null && maxWidth < target.width)
          || (maxHeight !== null && maxHeight < target.height)
          || (maxFramesPerSecond !== null && maxFramesPerSecond < target.framesPerSecond)) continue;
        try {
          await track.applyConstraints(captureConstraints(device.deviceId, target));
          const settings = track.getSettings();
          if (settings.width === target.width && settings.height === target.height
            && (settings.frameRate ?? 0) >= target.framesPerSecond * 0.8) supportedProfiles.push(profile);
        } catch {
          // This device cannot apply this exact profile even if its individual ranges suggest it can.
        }
      }
      const facingMode: 'user' | 'environment' | 'unknown' = Array.isArray(capabilities.facingMode)
        ? capabilities.facingMode.includes('environment') ? 'environment'
          : capabilities.facingMode.includes('user') ? 'user' : 'unknown'
        : 'unknown';
      if (supportedProfiles.length > 0) {
        cameras.push({
          id: device.deviceId,
          label: device.label.trim() || `Cámara ${index + 1}`,
          facingMode,
          maxWidth,
          maxHeight,
          maxFramesPerSecond,
          supportedProfiles,
        });
      }
      stopStream(probe);
    } catch {
      // Devices that cannot be opened are not offered to the producer.
    }
  }
  if (cameras.length === 0) throw new Error('No se ha podido abrir ninguna cámara del móvil.');
  return { cameras, audioAvailable };
}

async function openStream(
  cameraId: string,
  dimensions: { readonly width: number; readonly height: number; readonly framesPerSecond: number },
  audioAvailable: boolean,
  audioEnabled: boolean,
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: cameraId } },
    audio: audioAvailable,
  });
  try {
    const video = stream.getVideoTracks()[0];
    if (video === undefined) throw new Error('El móvil no devolvió una pista de vídeo.');
    await video.applyConstraints(captureConstraints(cameraId, dimensions));
    for (const track of stream.getAudioTracks()) track.enabled = audioEnabled;
    return stream;
  } catch (error) {
    stopStream(stream);
    throw error;
  }
}

function captureConstraints(
  cameraId: string,
  dimensions: { readonly width: number; readonly height: number; readonly framesPerSecond: number },
): MediaTrackConstraints {
  return {
    deviceId: { exact: cameraId },
    width: { exact: dimensions.width },
    height: { exact: dimensions.height },
    frameRate: { ideal: dimensions.framesPerSecond, min: Math.max(24, dimensions.framesPerSecond - 1) },
  };
}

function numericMaximum(value: MediaSettingsRange | undefined): number | null {
  const maximum = value?.max;
  return typeof maximum === 'number' && Number.isFinite(maximum) ? maximum : null;
}

function appliedMatches(desired: PilotMobileCameraDesired, applied: PilotMobileCameraApplied): boolean {
  const dimensions = profileDimensions(desired.profile);
  return applied.revision === desired.revision
    && applied.cameraId === desired.cameraId
    && applied.width === dimensions.width
    && applied.height === dimensions.height
    && applied.framesPerSecond >= dimensions.framesPerSecond * 0.8;
}

function reportableState(state: PilotMobileCameraState): 'connecting' | 'ready' | 'reconnecting' | 'degraded' | 'error' {
  switch (state) {
    case 'ready': return 'ready';
    case 'reconnecting': return 'reconnecting';
    case 'degraded': return 'degraded';
    case 'error': return 'error';
    case 'waiting_permission':
    case 'offline':
    case 'revoked':
    case 'connecting': return 'connecting';
    default: return assertNever(state);
  }
}

function mobileHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function localJson<T>(
  url: string,
  init: RequestInit,
  schema: { parse: (input: unknown) => T },
): Promise<T> {
  const response = await localFetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = typeof payload === 'object' && payload !== null && 'error' in payload
      && typeof payload.error === 'object' && payload.error !== null
      ? payload.error as Record<string, unknown> : null;
    const message = typeof errorPayload?.message === 'string'
      ? errorPayload.message : `El equipo de producción rechazó la petición (${response.status}).`;
    throw new PilotMobileApiError(typeof errorPayload?.code === 'string' ? errorPayload.code : 'HTTP_ERROR', message);
  }
  return schema.parse(payload);
}

function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const hostname = new URL(url).hostname;
  // The PC's preview uses loopback; the phone publishes through a LAN address.
  // Chrome rejects a declared "local" destination that resolves to loopback.
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  return fetch(url, { ...init, targetAddressSpace: loopback ? 'loopback' : 'local' } as RequestInit);
}

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener('icegatheringstatechange', change);
      signal.removeEventListener('abort', abort);
    };
    const change = () => {
      if (peer.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    peer.addEventListener('icegatheringstatechange', change);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function resourceUrl(base: string, location: string | null): string | null {
  if (location === null) return null;
  try { return new URL(location, base).toString(); } catch { return null; }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  const ipv6 = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (ipv6.includes(':')) {
    const first = Number.parseInt(ipv6.split(':', 1)[0] ?? '', 16);
    return Number.isInteger(first) && ((first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf));
  }
  if (!hostname.includes('.')) return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'OverconstrainedError') {
    return 'La cámara no pudo aplicar esa combinación de resolución y FPS.';
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Chrome necesita permiso para usar la cámara y el micrófono.';
  }
  return error instanceof Error ? error.message.slice(0, 500) : 'No se pudo preparar la cámara.';
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected mobile state: ${String(value)}`);
}
