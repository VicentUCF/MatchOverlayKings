export type ProductionEventScope = 'runtime' | 'configurations' | 'recordings';

export type ProductionInvalidation = {
  readonly scope: ProductionEventScope;
  readonly version: number;
  readonly occurredAt: string;
};

type Listener = (event: ProductionInvalidation) => void;

const COALESCE_MS: Readonly<Record<ProductionEventScope, number>> = {
  runtime: 2_000,
  configurations: 100,
  recordings: 1_000,
};

export class ProductionEventBus {
  private readonly listeners = new Set<Listener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly versions = new Map<ProductionEventScope, number>();
  private readonly lastEmittedAt = new Map<ProductionEventScope, number>();
  private readonly timers = new Map<ProductionEventScope, NodeJS.Timeout>();
  private closed = false;

  public publish(scope: ProductionEventScope): void {
    if (this.closed) return;
    this.versions.set(scope, (this.versions.get(scope) ?? 0) + 1);
    if (this.timers.has(scope)) return;
    const remaining = Math.max(0, COALESCE_MS[scope] - (Date.now() - (this.lastEmittedAt.get(scope) ?? 0)));
    if (remaining === 0) {
      this.emit(scope);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(scope);
      this.emit(scope);
    }, remaining);
    timer.unref();
    this.timers.set(scope, timer);
  }

  public subscribe(listener: Listener, closeListener?: () => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    if (closeListener !== undefined) this.closeListeners.add(closeListener);
    return () => {
      this.listeners.delete(listener);
      if (closeListener !== undefined) this.closeListeners.delete(closeListener);
    };
  }

  public snapshot(scope: ProductionEventScope): ProductionInvalidation {
    return this.event(scope);
  }

  public close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.listeners.clear();
  }

  private emit(scope: ProductionEventScope): void {
    if (this.closed) return;
    this.lastEmittedAt.set(scope, Date.now());
    const event = this.event(scope);
    for (const listener of this.listeners) listener(event);
  }

  private event(scope: ProductionEventScope): ProductionInvalidation {
    return { scope, version: this.versions.get(scope) ?? 0, occurredAt: new Date().toISOString() };
  }
}

export function productionSseEvent(event: ProductionInvalidation): string {
  return `event: invalidate\ndata: ${JSON.stringify(event)}\n\n`;
}
