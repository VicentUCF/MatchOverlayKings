import { once } from 'node:events';
import type { Writable } from 'node:stream';
import type { PilotCourtSlug } from '@kpl/production-contracts';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';

const OVERLAY_WIDTH = 1920;
const OVERLAY_HEIGHT = 1080;
const NAVIGATION_TIMEOUT_MS = 20_000;

export interface PilotOverlayOptions {
  readonly courtSlug: PilotCourtSlug;
  readonly framesPerSecond: 30 | 60;
  readonly homeTeamId?: string;
  readonly awayTeamId?: string;
}

export interface PilotOverlayRenderer {
  readonly start: (
    output: Writable,
    options: PilotOverlayOptions,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface BrowserPilotOverlayRendererOptions {
  readonly baseUrl: string;
  readonly chromiumExecutablePath?: string;
}

/** Renders the same React route used by OBS and feeds its transparent frames to FFmpeg. */
export class BrowserPilotOverlayRenderer implements PilotOverlayRenderer {
  private browserPromise: Promise<Browser> | null = null;

  public constructor(private readonly options: BrowserPilotOverlayRendererOptions) {}

  public async start(
    output: Writable,
    options: PilotOverlayOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const browser = await this.browser();
    const context = await browser.newContext({
      viewport: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
      screen: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    });
    const abort = () => { void context.close().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });

    try {
      const page = await context.newPage();
      await prepareOverlayPage(page, overlayUrl(this.options.baseUrl, options.courtSlug, options), signal);
      await pumpBrowserFrames(output, page, options.framesPerSecond, signal);
    } finally {
      signal.removeEventListener('abort', abort);
      await context.close().catch(() => undefined);
      if (!output.destroyed) output.end();
    }
  }

  public async close(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (pending !== null) {
      const browser = await pending.catch(() => null);
      await browser?.close().catch(() => undefined);
    }
  }

  private browser(): Promise<Browser> {
    if (this.browserPromise === null) {
      const launching = chromium.launch({
        headless: true,
        ...(this.options.chromiumExecutablePath
          ? { executablePath: this.options.chromiumExecutablePath }
          : {}),
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox',
        ],
      });
      this.browserPromise = launching;
      void launching.then((browser) => {
        browser.once('disconnected', () => {
          if (this.browserPromise === launching) this.browserPromise = null;
        });
      }).catch(() => {
        if (this.browserPromise === launching) this.browserPromise = null;
      });
    }
    return this.browserPromise;
  }
}

export function overlayUrl(baseUrl: string, courtSlug: PilotCourtSlug, identity?: { homeTeamId?: string; awayTeamId?: string }): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/overlay/${encodeURIComponent(courtSlug)}/scoreboard`;
  if (!identity?.homeTeamId || !identity.awayTeamId) return url;
  return `${url}?${new URLSearchParams({ homeTeamId: identity.homeTeamId, awayTeamId: identity.awayTeamId })}`;
}

async function prepareOverlayPage(page: Page, url: string, signal: AbortSignal): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  if (signal.aborted) return;
  await page.evaluate(`document.fonts.ready.then(() => new Promise(
    (resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)),
  ))`);
}

async function pumpBrowserFrames(
  output: Writable,
  page: Page,
  outputFramesPerSecond: number,
  signal: AbortSignal,
): Promise<void> {
  const capture = await startCompositorCapture(page, signal);

  try {
    const frameDurationMs = 1_000 / outputFramesPerSecond;
    let nextFrameAt = performance.now();
    while (!signal.aborted && !output.destroyed) {
      if (capture.error !== null) throw capture.error;
      const accepted = output.write(capture.frame);
      if (!accepted) await Promise.race([once(output, 'drain'), aborted(signal)]);
      nextFrameAt = Math.max(nextFrameAt + frameDurationMs, performance.now());
      const waitMs = Math.max(0, nextFrameAt - performance.now());
      if (waitMs > 0) await Promise.race([delay(waitMs), aborted(signal)]);
    }
  } catch (error) {
    if (!signal.aborted && !isClosedPipe(error)) throw error;
  } finally {
    await capture.stop();
  }
}

interface ScreencastFrameEvent {
  readonly data: string;
  readonly sessionId: number;
}

interface CompositorCapture {
  readonly frame: Uint8Array;
  readonly error: unknown;
  readonly stop: () => Promise<void>;
}

async function startCompositorCapture(page: Page, signal: AbortSignal): Promise<CompositorCapture> {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  let frame: Uint8Array | null = null;
  let captureError: unknown = null;
  let resolveFirstFrame: (() => void) | null = null;
  const firstFrame = new Promise<void>((resolve) => { resolveFirstFrame = resolve; });
  const onFrame = (event: ScreencastFrameEvent) => {
    frame = Buffer.from(event.data, 'base64');
    resolveFirstFrame?.();
    resolveFirstFrame = null;
    void acknowledgeFrame(client, event.sessionId).catch((error: unknown) => {
      captureError = error;
    });
  };
  client.on('Page.screencastFrame', onFrame);
  await client.send('Page.startScreencast', {
    format: 'png',
    maxWidth: OVERLAY_WIDTH,
    maxHeight: OVERLAY_HEIGHT,
    everyNthFrame: 1,
  });
  await Promise.race([firstFrame, aborted(signal)]);
  if (frame === null) {
    await stopCompositorCapture(client, onFrame);
    throw new Error('Overlay capture stopped before its first frame');
  }

  return {
    get frame() { return frame as Uint8Array; },
    get error() { return captureError; },
    stop: () => stopCompositorCapture(client, onFrame),
  };
}

async function acknowledgeFrame(client: CDPSession, sessionId: number): Promise<void> {
  await client.send('Page.screencastFrameAck', { sessionId });
}

async function stopCompositorCapture(
  client: CDPSession,
  onFrame: (event: ScreencastFrameEvent) => void,
): Promise<void> {
  client.off('Page.screencastFrame', onFrame);
  await client.send('Page.stopScreencast').catch(() => undefined);
  await client.detach().catch(() => undefined);
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
