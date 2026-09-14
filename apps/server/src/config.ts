import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PilotYouTubeConfig } from './pilot-youtube.js';

export interface PilotServerConfig {
  ffmpegPath: string;
  youtube: PilotYouTubeConfig;
  mobileCamera?: PilotMobileCameraRuntimeConfig;
  controlOrigins?: readonly string[];
}

export interface PilotMobileCameraRuntimeConfig {
  mediaMtxPath: string | null;
  lanHost: string | null;
  lanCidr: string | null;
  cameraPageOrigin: string;
  webRtcPort: number;
  webRtcUdpPort: number;
  rtspPort: number;
  apiPort: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  webDistDir: string;
  controlPin: string | null;
  pilot: PilotServerConfig;
}

export function readConfig(): ServerConfig {
  const credentials = readGoogleOAuthCredentials(process.env.KPL_PILOT_YOUTUBE_CREDENTIALS_PATH);
  const cameraPageOrigin = origin(process.env.KPL_PILOT_CAMERA_PAGE_ORIGIN);
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 4300),
    dataDir: process.env.KPL_DATA_DIR
      ? resolve(process.env.KPL_DATA_DIR)
      : resolve(process.cwd(), '../../data'),
    webDistDir: process.env.KPL_WEB_DIST
      ? resolve(process.env.KPL_WEB_DIST)
      : resolve(process.cwd(), '../web/dist'),
    controlPin: process.env.KPL_CONTROL_PIN?.trim() || null,
    pilot: {
      ffmpegPath: process.env.KPL_PILOT_FFMPEG_PATH?.trim() || '/bin/ffmpeg',
      controlOrigins: origins(process.env.KPL_PILOT_CONTROL_ORIGINS, cameraPageOrigin),
      mobileCamera: {
        mediaMtxPath: process.env.KPL_PILOT_MEDIAMTX_PATH?.trim() || null,
        lanHost: process.env.KPL_PILOT_LAN_HOST?.trim() || null,
        lanCidr: process.env.KPL_PILOT_LAN_CIDR?.trim() || null,
        cameraPageOrigin,
        webRtcPort: port(process.env.KPL_PILOT_WEBRTC_PORT, 8889),
        webRtcUdpPort: port(process.env.KPL_PILOT_WEBRTC_UDP_PORT, 8189),
        rtspPort: port(process.env.KPL_PILOT_RTSP_PORT, 8554),
        apiPort: port(process.env.KPL_PILOT_MEDIAMTX_API_PORT, 9998),
      },
      youtube: {
        clientId: process.env.KPL_PILOT_YOUTUBE_CLIENT_ID?.trim() || credentials?.clientId || null,
        clientSecret: process.env.KPL_PILOT_YOUTUBE_CLIENT_SECRET?.trim() || credentials?.clientSecret || null,
        redirectUri: process.env.KPL_PILOT_YOUTUBE_REDIRECT_URI?.trim()
          || `http://localhost:${Number(process.env.PORT ?? 4300)}/api/pilot/youtube/auth/callback`,
        tokenPath: process.env.KPL_PILOT_YOUTUBE_TOKEN_PATH
          ? resolve(process.env.KPL_PILOT_YOUTUBE_TOKEN_PATH)
          : null,
      },
    },
  };
}

function origins(value: string | undefined, fallback: string): readonly string[] {
  const candidates = value?.split(',').map((candidate) => candidate.trim()).filter(Boolean) ?? [];
  const valid = candidates.flatMap((candidate) => {
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === 'https:' ? [parsed.origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(valid.length > 0 ? valid : [fallback])];
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535 ? parsed : fallback;
}

function origin(value: string | undefined): string {
  const candidate = value?.trim() || 'https://live.kingspadelleague.com';
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.origin : 'https://live.kingspadelleague.com';
  } catch {
    return 'https://live.kingspadelleague.com';
  }
}

function readGoogleOAuthCredentials(path: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!path?.trim()) return null;
  try {
    const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('web' in parsed)) return null;
    const web = (parsed as { web?: unknown }).web;
    if (typeof web !== 'object' || web === null) return null;
    const { client_id: clientId, client_secret: clientSecret } = web as Record<string, unknown>;
    return typeof clientId === 'string' && clientId.length > 0
      && typeof clientSecret === 'string' && clientSecret.length > 0
      ? { clientId, clientSecret }
      : null;
  } catch {
    return null;
  }
}
