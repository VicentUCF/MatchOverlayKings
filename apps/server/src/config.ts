import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PilotYouTubeConfig } from './pilot-youtube.js';

export interface PilotServerConfig {
  ffmpegPath: string;
  youtube: PilotYouTubeConfig;
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
