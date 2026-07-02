import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  ensureMatchState,
  parseEventDefinition,
  parseTeams,
  validateKnownTeams,
} from '@kpl/shared';
import type { EventDefinition, EventId, MatchState, Team } from '@kpl/shared';

export interface EventSummary {
  id: EventId;
  title: string;
  courtName: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchState['status'];
  version: number;
  updatedAt: string;
}

export class FileStore {
  private teamsCache: Team[] | null = null;
  private readonly stateCache = new Map<EventId, MatchState>();
  private readonly eventCache = new Map<EventId, EventDefinition>();
  private readonly locks = new Map<EventId, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  async getTeams(): Promise<Team[]> {
    if (this.teamsCache) {
      return this.teamsCache;
    }

    const raw = await this.readJson(join(this.dataDir, 'teams.json'));
    this.teamsCache = parseTeams(raw);
    return this.teamsCache;
  }

  async listEvents(): Promise<EventSummary[]> {
    const eventsDir = join(this.dataDir, 'events');
    const files = await readdir(eventsDir);
    const summaries: EventSummary[] = [];

    for (const file of files.filter((item) => item.endsWith('.json')).sort()) {
      const eventId = basename(file, '.json');
      const state = await this.getEventState(eventId);

      summaries.push({
        id: state.id,
        title: state.title,
        courtName: state.courtName,
        homeTeamId: state.homeTeamId,
        awayTeamId: state.awayTeamId,
        status: state.status,
        version: state.version,
        updatedAt: state.updatedAt,
      });
    }

    return summaries;
  }

  async getEventState(eventId: EventId): Promise<MatchState> {
    this.assertSafeEventId(eventId);

    const cached = this.stateCache.get(eventId);

    if (cached) {
      return cached;
    }

    const event = await this.readEvent(eventId);
    const state = ensureMatchState(event);

    this.eventCache.set(eventId, { ...event, state });
    this.stateCache.set(eventId, state);

    if (!event.state) {
      await this.persistEvent(eventId, { ...event, state });
    }

    return state;
  }

  async updateEventState(
    eventId: EventId,
    updater: (state: MatchState) => MatchState,
  ): Promise<MatchState> {
    return this.withEventLock(eventId, async () => {
      const current = await this.getEventState(eventId);
      const next = updater(current);
      const event = this.eventCache.get(eventId) ?? (await this.readEvent(eventId));
      const nextEvent: EventDefinition = {
        ...event,
        title: next.title,
        homeTeamId: next.homeTeamId,
        awayTeamId: next.awayTeamId,
        lineups: next.lineups,
        servingSide: next.servingSide,
        courtName: next.courtName,
        status: next.status,
        config: next.config,
        state: next,
      };

      await this.persistEvent(eventId, nextEvent);
      this.eventCache.set(eventId, nextEvent);
      this.stateCache.set(eventId, next);

      return next;
    });
  }

  private async readEvent(eventId: EventId): Promise<EventDefinition> {
    this.assertSafeEventId(eventId);

    const raw = await this.readJson(join(this.dataDir, 'events', `${eventId}.json`));
    const event = parseEventDefinition(raw);
    const teams = await this.getTeams();

    validateKnownTeams(event, teams);

    return event;
  }

  private async persistEvent(eventId: EventId, event: EventDefinition): Promise<void> {
    this.assertSafeEventId(eventId);

    const eventsDir = join(this.dataDir, 'events');
    const targetPath = join(eventsDir, `${eventId}.json`);
    const tempPath = join(eventsDir, `${eventId}.${process.pid}.${Date.now()}.tmp`);
    const payload = `${JSON.stringify(event, null, 2)}\n`;

    await mkdir(eventsDir, { recursive: true });
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, targetPath);
  }

  private async readJson(path: string): Promise<unknown> {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as unknown;
  }

  private async withEventLock<T>(eventId: EventId, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(eventId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queued = previous.then(() => current);
    this.locks.set(eventId, queued);

    try {
      await previous;
      return await action();
    } finally {
      release();

      if (this.locks.get(eventId) === queued) {
        this.locks.delete(eventId);
      }
    }
  }

  private assertSafeEventId(eventId: EventId): void {
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/i.test(eventId)) {
      throw new Error(`eventId invalido: ${eventId}`);
    }
  }
}
