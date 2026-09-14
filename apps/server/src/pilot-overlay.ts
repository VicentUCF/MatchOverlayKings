import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { renderLiveScoreboardRgba } from '@kpl/production-assets';
import { formatPoint, type MatchState, type Team } from '@kpl/shared';
import type { PilotCourtSlug } from '@kpl/production-contracts';

const SCORE_REFRESH_MS = 1_000;

export interface PilotOverlayOptions {
  readonly courtSlug: PilotCourtSlug;
  readonly title: string;
  readonly courtName: string;
  readonly homeName: string;
  readonly awayName: string;
  readonly framesPerSecond: 30 | 60;
  readonly supabaseUrl?: string;
  readonly supabasePublishableKey?: string;
}

export function startPilotOverlayPump(
  output: Writable,
  options: PilotOverlayOptions,
  signal: AbortSignal,
): Promise<void> {
  return pumpFrames(output, options, signal);
}

export function pilotOverlayFrame(
  options: PilotOverlayOptions,
  state: MatchState | null,
  teams: readonly Team[] = [],
): Uint8Array {
  const home = state ? teams.find((team) => team.id === state.homeTeamId) : undefined;
  const away = state ? teams.find((team) => team.id === state.awayTeamId) : undefined;
  const visible = state === null || (state.status === 'live' && state.overlaySettings.visible !== false);
  const sets = state?.sets.slice(0, 3) ?? [];
  return renderLiveScoreboardRgba({
    // The transparent source only covers the top-left scoreboard region. Keeping it cropped
    // avoids decoding a mostly-empty 1080p PNG for every programme frame.
    width: 960,
    height: 270,
    title: state?.title || options.title,
    courtName: state?.courtName || options.courtName,
    homeName: home?.shortName || home?.name || options.homeName,
    awayName: away?.shortName || away?.name || options.awayName,
    ...(home?.primaryColor ? { homeColor: home.primaryColor } : {}),
    ...(away?.primaryColor ? { awayColor: away.primaryColor } : {}),
    homeSets: sets.map((set) => set.homeGames),
    awaySets: sets.map((set) => set.awayGames),
    homePoint: state?.status === 'live' ? formatPoint(state, 'home') : '0',
    awayPoint: state?.status === 'live' ? formatPoint(state, 'away') : '0',
    servingSide: state?.servingSide ?? 'home',
    visible,
  });
}

async function pumpFrames(output: Writable, options: PilotOverlayOptions, signal: AbortSignal): Promise<void> {
  let frame = pilotOverlayFrame(options, null);
  let refreshInFlight = false;
  const refresh = async () => {
    if (refreshInFlight || signal.aborted) return;
    refreshInFlight = true;
    try {
      const snapshot = await fetchOverlaySnapshot(options, signal);
      if (snapshot !== null) frame = pilotOverlayFrame(options, snapshot.state, snapshot.teams);
    } catch {
      // Keep the last valid frame. A scoreboard refresh must never interrupt the programme output.
    } finally {
      refreshInFlight = false;
    }
  };
  void refresh();
  const refreshTimer = setInterval(() => void refresh(), SCORE_REFRESH_MS);
  refreshTimer.unref();

  try {
    const frameDurationMs = 1_000 / options.framesPerSecond;
    let nextFrameAt = performance.now();
    while (!signal.aborted && !output.destroyed) {
      const accepted = output.write(frame);
      // FFmpeg opens all inputs before consuming the graph. Seed enough raw frames to avoid
      // a startup deadlock caused by Node's much smaller default stream high-water mark.
      if (!accepted && output.writableLength >= frame.byteLength * 16) {
        await Promise.race([once(output, 'drain'), aborted(signal)]);
      }
      nextFrameAt += frameDurationMs;
      const waitMs = Math.max(0, nextFrameAt - performance.now());
      if (waitMs > 0) await Promise.race([delay(waitMs), aborted(signal)]);
    }
  } catch (error) {
    if (!signal.aborted && !isClosedPipe(error)) throw error;
  } finally {
    clearInterval(refreshTimer);
    if (!output.destroyed) output.end();
  }
}

async function fetchOverlaySnapshot(
  options: PilotOverlayOptions,
  signal: AbortSignal,
): Promise<{ readonly state: MatchState; readonly teams: readonly Team[] } | null> {
  const supabaseUrl = options.supabaseUrl?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = options.supabasePublishableKey?.trim() || process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !key) return null;
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const scoreUrl = `${baseUrl}/rest/v1/score_states?court_slug=eq.${encodeURIComponent(options.courtSlug)}&select=state&limit=1`;
  const teamsUrl = `${baseUrl}/rest/v1/teams?select=id,name,short_name,logo_url,primary_color,secondary_color`;
  const [scoreResponse, teamsResponse] = await Promise.all([
    fetch(scoreUrl, { headers, signal }),
    fetch(teamsUrl, { headers, signal }),
  ]);
  if (!scoreResponse.ok || !teamsResponse.ok) return null;
  const scoreRows = await scoreResponse.json() as Array<{ state?: MatchState }>;
  const state = scoreRows[0]?.state;
  if (!state) return null;
  const teamRows = await teamsResponse.json() as Array<{
    id: string; name: string; short_name: string; logo_url: string; primary_color: string; secondary_color: string;
  }>;
  return {
    state,
    teams: teamRows.map((team) => ({
      id: team.id,
      name: team.name,
      shortName: team.short_name,
      logoUrl: team.logo_url,
      primaryColor: team.primary_color,
      secondaryColor: team.secondary_color,
    })),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function isClosedPipe(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED');
}
