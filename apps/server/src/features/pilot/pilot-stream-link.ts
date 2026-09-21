import type { PilotCourtSlug } from '@kpl/production-contracts';

export interface PilotStreamLink {
  publish(courtSlug: PilotCourtSlug, watchUrl: string | null, authorization?: string): Promise<void>;
}

/** Uses the operator's session; never grants the local agent database admin credentials. */
export class SupabasePilotStreamLink implements PilotStreamLink {
  public constructor(
    private readonly config: { url: string; publishableKey: string } | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async publish(courtSlug: PilotCourtSlug, watchUrl: string | null, authorization?: string): Promise<void> {
    if (!this.config?.url || !this.config.publishableKey) {
      throw new Error('Supabase is not configured for the public stream link.');
    }
    if (!authorization?.startsWith('Bearer ')) {
      throw new Error('The public stream link needs the operator session.');
    }
    const response = await this.fetcher(`${this.config.url.replace(/\/+$/, '')}/rest/v1/rpc/publish_court_stream`, {
      method: 'POST',
      headers: { apikey: this.config.publishableKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_court_slug: courtSlug, p_watch_url: watchUrl }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`The public stream link was rejected with status ${response.status}.`);
    }
  }
}
