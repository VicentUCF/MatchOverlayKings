import type { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { PilotCourtSlug, PilotOverlayHealth } from '@kpl/production-contracts';
import { chromium, type Browser, type BrowserContext, type CDPSession } from 'playwright';
import { PilotOverlayFeed } from './pilot-overlay-feed.js';

const OVERLAY_WIDTH = 1920;
const OVERLAY_HEIGHT = 1080;
const READY = `(() => {
  const marker = document.querySelector('[data-pilot-match-ready="true"]');
  const confirmedAt = Number(marker?.getAttribute('data-pilot-confirmed-at'));
  const age = Date.now() - confirmedAt;
  return !!marker && confirmedAt > 0 && age >= 0 && age < 15000;
})()`;

export interface PilotOverlayOptions {
  readonly courtSlug: PilotCourtSlug;
  readonly framesPerSecond: 30 | 60;
  readonly homeTeamId?: string;
  readonly awayTeamId?: string;
  readonly onState?: (state: PilotOverlayHealth) => void;
}

export interface PilotOverlayRenderer {
  readonly start: (output: Writable, options: PilotOverlayOptions, signal: AbortSignal) => Promise<void>;
  readonly recover?: (courtSlug: PilotCourtSlug) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface BrowserPilotOverlayRendererOptions {
  readonly baseUrl: string;
  readonly chromiumExecutablePath?: string;
}

/** One browser, isolated pages per court, and independent frame clocks for FFmpeg. */
export class BrowserPilotOverlayRenderer implements PilotOverlayRenderer {
  private browserPromise: Promise<Browser> | null = null;
  private readonly feeds = new Map<PilotCourtSlug, PilotOverlayFeed>();
  private closed = false;

  public constructor(private readonly options: BrowserPilotOverlayRendererOptions,
    private readonly launch: () => Promise<Browser> = () => chromium.launch({
      headless: true,
      ...(options.chromiumExecutablePath ? { executablePath: options.chromiumExecutablePath } : {}),
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
    })) {}

  public async start(output: Writable, options: PilotOverlayOptions, signal: AbortSignal): Promise<void> {
    const previous = this.feeds.get(options.courtSlug);
    if (previous) await previous.close().catch(() => undefined);
    if (this.closed || signal.aborted) return;
    const feed = new PilotOverlayFeed((frame, attempt) => this.capture(options, frame, attempt),
      options.framesPerSecond, (state) => options.onState?.(state));
    this.feeds.set(options.courtSlug, feed);
    try { await feed.start(output, signal); }
    finally {
      if (this.feeds.get(options.courtSlug) === feed) this.feeds.delete(options.courtSlug);
      if (!output.destroyed) output.end();
    }
  }

  public async recover(courtSlug: PilotCourtSlug): Promise<void> {
    const feed = this.feeds.get(courtSlug);
    if (!feed) throw new Error('Overlay is not running');
    feed.recover();
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.feeds.values()].map((feed) => feed.close()));
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (pending) {
      const browser = await bounded(pending, undefined, 5_000).catch(() => null);
      if (browser) await bounded(browser.close(), undefined, 5_000).catch(() => undefined);
    }
  }

  private browser(): Promise<Browser> {
    if (this.browserPromise === null) {
      const launching = this.launch();
      this.browserPromise = launching;
      void launching.then((browser) => {
        browser.once('disconnected', () => { if (this.browserPromise === launching) this.browserPromise = null; });
        if (this.closed) void browser.close().catch(() => undefined);
      }).catch(() => { if (this.browserPromise === launching) this.browserPromise = null; });
    }
    return this.browserPromise;
  }

  private async capture(options: PilotOverlayOptions, frame: (png: Uint8Array) => void, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    const remaining = () => Math.max(1, deadline - Date.now());
    const browser = await bounded(this.browser(), signal, remaining());
    const creating = browser.newContext({
      viewport: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT },
      screen: { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }, deviceScaleFactor: 1, reducedMotion: 'no-preference',
    });
    let abandoned = false;
    void creating.then((context) => { if (abandoned || signal.aborted) void context.close().catch(() => undefined); }).catch(() => undefined);
    let context: BrowserContext;
    try { context = await bounded(creating, signal, remaining()); }
    catch (error) { abandoned = true; throw error; }
    let closing: Promise<void> | null = null;
    const close = () => {
      closing ??= bounded(context.close(), undefined, 3_000);
      void closing.catch(() => undefined);
      return closing;
    };
    const abort = () => { void close().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    let client: CDPSession | null = null;
    let onFrame: ((event: ScreencastFrameEvent) => void) | null = null;
    try {
      const page = await bounded(context.newPage(), signal, remaining());
      const response = await page.goto(overlayUrl(this.options.baseUrl, options.courtSlug, options),
        { waitUntil: 'domcontentloaded', timeout: remaining() });
      if (!response?.ok()) throw new Error('Overlay page unavailable');
      await page.waitForFunction(READY, undefined, { timeout: remaining() });
      await bounded(page.evaluate(`document.fonts.ready.then(() => new Promise(
        (resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ))`), signal, remaining());
      client = await bounded(context.newCDPSession(page), signal, remaining());
      await bounded(client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }), signal, remaining());
      let fault: unknown = null;
      let pending: Buffer | null = null;
      let validating = false;
      let delivered = false;
      const fail = () => { fault = new Error('Overlay browser stopped responding'); };
      page.on('crash', fail); page.on('close', fail);
      const check = async () => {
        if (!await bounded(page.evaluate<boolean>(READY), signal, 2_000)) throw new Error('Overlay match data unavailable');
      };
      const flush = async () => {
        if (validating) return;
        validating = true;
        try {
          while (pending && !signal.aborted && !fault) {
            const current = pending; pending = null;
            await check();
            if (!delivered && Date.now() >= deadline) throw new Error('Overlay first frame timed out');
            if (!signal.aborted && !fault) { delivered = true; frame(current); }
          }
        } catch (error) { fault = error; }
        finally { validating = false; }
      };
      onFrame = (event) => {
        pending = Buffer.from(event.data, 'base64');
        void client!.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(fail);
        void flush();
      };
      client.on('Page.screencastFrame', onFrame);
      await bounded(client.send('Page.startScreencast', { format: 'png', maxWidth: OVERLAY_WIDTH, maxHeight: OVERLAY_HEIGHT, everyNthFrame: 1 }), signal, remaining());
      let nextCompositorCheck = 0;
      while (!signal.aborted) {
        if (fault) throw fault;
        if (!delivered && Date.now() >= deadline) throw new Error('Overlay first frame timed out');
        await check();
        // Static pages need no screencast events. A bounded screenshot probes the
        // compositor too, so a responsive JS thread cannot hide a frozen renderer.
        if (performance.now() >= nextCompositorCheck) {
          await bounded(client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }), signal, 2_000);
          await check();
          // Only the ordered screencast publishes frames. A slow screenshot
          // response must never overwrite a newer scoreboard image.
          nextCompositorCheck = performance.now() + 5_000;
        }
        await delay(1_000, undefined, { signal, ref: false });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      if (client && onFrame) client.off('Page.screencastFrame', onFrame);
      await close();
    }
  }
}

interface ScreencastFrameEvent { readonly data: string; readonly sessionId: number }

export function overlayUrl(baseUrl: string, courtSlug: PilotCourtSlug, identity?: { homeTeamId?: string; awayTeamId?: string }): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/overlay/${encodeURIComponent(courtSlug)}/scoreboard`;
  if (!identity?.homeTeamId || !identity.awayTeamId) return url;
  return `${url}?${new URLSearchParams({ homeTeamId: identity.homeTeamId, awayTeamId: identity.awayTeamId })}`;
}

function bounded<T>(task: Promise<T>, signal: AbortSignal | undefined, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('Overlay operation cancelled')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Overlay operation timed out')); }, milliseconds);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void task.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}
