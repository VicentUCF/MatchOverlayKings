import { supabase } from '../../lib/supabase.js';

export type ProductionEventScope = 'runtime' | 'configurations' | 'recordings';
export type ProductionInvalidation = {
  readonly scope: ProductionEventScope;
  readonly version: number;
  readonly occurredAt: string;
};

type LocalNetworkRequestInit = RequestInit & { readonly targetAddressSpace?: 'loopback' };

export function subscribeToProductionEvents(
  baseUrl: string,
  listener: (event: ProductionInvalidation) => void,
  fetcher: typeof fetch = fetch,
): () => void {
  let active = true;
  let controller: AbortController | null = null;
  let retryTimer: number | undefined;
  let retryMs = 1_000;

  const scheduleReconnect = () => {
    if (!active) return;
    retryTimer = window.setTimeout(() => { void connect(); }, retryMs);
    retryMs = Math.min(30_000, retryMs * 2);
  };
  const connect = async () => {
    if (!active) return;
    controller = new AbortController();
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error('Production event stream requires a session');
      const init: LocalNetworkRequestInit = {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${data.session.access_token}` },
        cache: 'no-store',
        signal: controller.signal,
        ...(isLoopbackHttp(baseUrl) ? { targetAddressSpace: 'loopback' as const } : {}),
      };
      const response = await fetcher(`${baseUrl}/api/pilot/events`, init);
      if (!response.ok || response.body === null) throw new Error('Production event stream unavailable');
      retryMs = 1_000;
      await consumeProductionEvents(response.body, listener, controller.signal);
    } catch (error) {
      if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
    } finally {
      controller = null;
      scheduleReconnect();
    }
  };

  void connect();
  return () => {
    active = false;
    controller?.abort();
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  };
}

export async function consumeProductionEvents(
  stream: ReadableStream<Uint8Array>,
  listener: (event: ProductionInvalidation) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = parseProductionEventBlock(buffer.slice(0, boundary));
        if (event !== null) listener(event);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseProductionEventBlock(block: string): ProductionInvalidation | null {
  const lines = block.replaceAll('\r', '').split('\n');
  if (!lines.includes('event: invalidate')) return null;
  const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
  if (data === undefined) return null;
  try {
    const event = JSON.parse(data) as Record<string, unknown>;
    return ['runtime', 'configurations', 'recordings'].includes(String(event.scope))
      && Number.isInteger(event.version) && Number(event.version) >= 0
      && typeof event.occurredAt === 'string'
      ? event as ProductionInvalidation
      : null;
  } catch {
    return null;
  }
}

function isLoopbackHttp(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl || globalThis.location?.origin || 'http://localhost');
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
