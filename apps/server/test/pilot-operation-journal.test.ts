import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PilotConfigurationSchema, PilotSessionSchema } from '@kpl/production-contracts';
import { PilotOperationJournal } from '../src/pilot-operation-journal.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const context = { kind: 'configure', courtSlug: 'pista-1', sessionId: null, matchdayNumber: 1, seasonLabel: 'T2' } as const;
const configuration = PilotConfigurationSchema.parse({
  courtSlug: 'pista-1', mode: 'simulation', sourceId: 'synthetic', homeTeam: 'Kings', awayTeam: 'Lions',
  matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: '2026-09-20T12:00:00.000Z',
  privacyStatus: 'private', updatedAt: '2026-09-19T12:00:00.000Z',
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-journal-'));
  directories.push(directory);
  const path = join(directory, 'operations.json');
  const journal = new PilotOperationJournal(path);
  await journal.initialize();
  return { journal, path };
}

describe('durable operation journal', () => {
  it('records a camera-service failure and recovery without inventing a broadcast session or leaking runtime errors', async () => {
    const { journal, path } = await fixture();
    const mobileSessionId = randomUUID();
    const context = { sessionId: null, status: null, operationId: null, matchdayNumber: null, seasonLabel: null };
    const event = { id: randomUUID(), courtSlug: 'pista-3', mobileSessionId, code: 'exhausted' as const,
      attempt: 5, createdAt: new Date().toISOString() };
    await journal.recordMobileRuntime(event, context);
    await journal.recordMobileRuntime(event, context);
    await journal.recordMobileRuntime({ ...event, id: randomUUID() }, context);
    expect(journal.incidentHistory()).toHaveLength(1);
    expect(journal.incidentHistory()[0]).toMatchObject({ category: 'mobile_runtime', mobileRuntimeCode: 'exhausted',
      mobileSessionId, sessionId: null, status: null, severity: 'critical', resolved: false, attempt: 5 });
    await journal.recordMobileRuntime({ ...event, id: randomUUID(), code: 'restored', attempt: 0 }, context);
    const restarted = new PilotOperationJournal(path); await restarted.initialize();
    expect(restarted.incidentHistory()).toHaveLength(2);
    expect(restarted.incidentHistory()[1]).toMatchObject({ severity: 'info', resolved: true, mobileRuntimeCode: 'restored' });
    expect(restarted.incidentHistory()[1]?.message).toContain('confirme de nuevo su perfil y señal');
  });

  it('records each signal warning and its resolution once without changing session-state history', async () => {
    const { journal, path } = await fixture();
    const session = PilotSessionSchema.parse({ id: randomUUID(), courtSlug: 'pista-1', mode: 'simulation',
      source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' }, status: 'live', title: 'Partido', description: 'Partido',
      thumbnailUrl: '/thumbnail', broadcastId: null, watchUrl: null, youtubeStreamStatus: null, encoder: null,
      startedAt: null, stoppedAt: null, error: null,
      signal: { sampledAt: new Date().toISOString(), checking: false, lastVideoSampleAt: new Date().toISOString(), audioExpected: false,
        measuredFramesPerSecond: 30, measuredSpeed: 1, measuredBitrateKbps: null, droppedFrameRatio: 0,
        issues: [{ code: 'black_video', since: new Date().toISOString(), message: 'Revisa la lente.' }] },
    });
    await journal.recordState(session, 1, 'T2');
    await journal.recordSignal(session, 1, 'T2');
    await journal.recordSignal(session, 1, 'T2');
    await journal.recordState(session, 1, 'T2');
    await journal.recordSignal({ ...session, signal: { ...session.signal!, issues: [] } }, 1, 'T2');
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    expect(restarted.incidentHistory().filter(({ category }) => category === 'state')).toHaveLength(1);
    expect(restarted.incidentHistory().filter(({ category }) => category === 'signal').map(({ resolved, severity }) => ({ resolved, severity })))
      .toEqual([{ resolved: false, severity: 'warning' }, { resolved: true, severity: 'info' }]);
  });

  it('retains incidents with court, matchday, severity and operation correlation across restart', async () => {
    const { journal, path } = await fixture();
    const session = PilotSessionSchema.parse({
      id: randomUUID(), courtSlug: 'pista-1', mode: 'simulation',
      source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' }, status: 'prepared',
      title: 'Kings vs Lions', description: 'Partido', thumbnailUrl: '/thumbnail',
      broadcastId: null, watchUrl: null, youtubeStreamStatus: null, encoder: null,
      startedAt: null, stoppedAt: null, error: null,
    });
    const operationId = randomUUID();
    await journal.execute(operationId, { ...context, kind: 'prepare' }, {}, async () => session);
    await journal.recordState(session, 1, 'T2');
    await journal.recordState(session, 1, 'T2');
    await journal.recordState({ ...session, status: 'failed', error: 'La fuente no responde.' }, 1, 'T2');
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    expect(restarted.incidentHistory()).toHaveLength(2);
    expect(restarted.incidentHistory()[1]).toMatchObject({
      courtSlug: 'pista-1', matchdayNumber: 1, seasonLabel: 'T2', operationId,
      previousStatus: 'prepared', status: 'failed', severity: 'critical', message: 'La fuente no responde.',
    });
  });

  it('records intent before side effects, joins concurrent duplicates and replays after restart', async () => {
    const { journal, path } = await fixture();
    const id = randomUUID();
    const action = vi.fn(async () => {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      expect(saved.entries[0].operation.status).toBe('pending');
      return configuration;
    });
    const results = await Promise.all([
      journal.execute(id, context, { a: 1, b: 2 }, action),
      journal.execute(id, context, { b: 2, a: 1 }, action),
    ]);
    expect(results).toEqual([configuration, configuration]);
    expect(action).toHaveBeenCalledTimes(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    expect(await restarted.execute(id, context, { a: 1, b: 2 }, action)).toEqual(configuration);
    expect(action).toHaveBeenCalledTimes(1);
    expect(restarted.list()[0]).toMatchObject({ status: 'completed', courtSlug: 'pista-1', matchdayNumber: 1 });
  });

  it('rejects reuse with a different request or court', async () => {
    const { journal } = await fixture();
    const id = randomUUID();
    await journal.execute(id, context, { a: 1 }, async () => configuration);
    const action = vi.fn(async () => configuration);
    await expect(journal.execute(id, context, { a: 2 }, action)).rejects.toThrow('otra operación');
    await expect(journal.execute(id, { ...context, courtSlug: 'pista-2' }, { a: 1 }, action)).rejects.toThrow('otra operación');
    expect(action).not.toHaveBeenCalled();
  });

  it('retains uncertain operations on restart and never silently executes them again', async () => {
    const { journal, path } = await fixture();
    const id = randomUUID();
    await journal.execute(id, context, {}, async () => configuration);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.entries[0].operation.status = 'pending';
    saved.entries[0].result = null;
    await writeFile(path, JSON.stringify(saved));
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    expect(restarted.list()[0]?.status).toBe('interrupted');
    expect(() => restarted.assertNoUnresolvedPreparation('pista-1')).not.toThrow();
    const action = vi.fn(async () => configuration);
    await expect(restarted.execute(id, context, {}, action)).rejects.toMatchObject({ code: 'OPERATION_INTERRUPTED' });
    expect(action).not.toHaveBeenCalled();
  });

  it('reconciles an interrupted receipt with its durable session and blocks unidentified preparations', async () => {
    const { journal, path } = await fixture();
    const session = PilotSessionSchema.parse({
      id: randomUUID(), courtSlug: 'pista-1', mode: 'simulation',
      source: { id: 'synthetic', kind: 'synthetic', label: 'Prueba' }, status: 'prepared',
      title: 'Kings vs Lions', description: 'Partido', thumbnailUrl: '/thumbnail',
      broadcastId: null, watchUrl: null, youtubeStreamStatus: null, encoder: null,
      startedAt: null, stoppedAt: null, error: null,
    });
    const id = randomUUID();
    await journal.execute(id, { ...context, kind: 'prepare' }, {}, async () => session);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.entries[0].operation.status = 'pending';
    saved.entries[0].operation.sessionId = null;
    saved.entries[0].externalEffectStarted = true;
    saved.entries[0].result = null;
    await writeFile(path, JSON.stringify(saved));
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    expect(() => restarted.assertNoUnresolvedPreparation('pista-1')).toThrow('preparación interrumpida');
    await restarted.reconcileSessions([{ public: session, preparationOperationId: id }]);
    expect(() => restarted.assertNoUnresolvedPreparation('pista-1')).not.toThrow();
    const action = vi.fn(async () => session);
    expect(await restarted.execute(id, { ...context, kind: 'prepare' }, {}, action)).toEqual(session);
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps raw errors and inputs out of the persisted journal and public history', async () => {
    const { journal, path } = await fixture();
    const id = randomUUID();
    await expect(journal.execute(id, context, { token: 'secret-input' }, async () => {
      throw new Error('secret-upstream');
    })).rejects.toThrow('secret-upstream');
    expect(await readFile(path, 'utf8')).not.toContain('secret');
    expect(JSON.stringify(journal.list())).not.toContain('fingerprint');
    expect(journal.list()[0]?.status).toBe('failed');
  });

  it('blocks a new broadcast after an ambiguous remote failure, including after restart', async () => {
    const { journal, path } = await fixture();
    const id = randomUUID();
    await expect(journal.execute(id, { ...context, kind: 'prepare' }, {}, async () => {
      await journal.markExternalEffect(id);
      expect(JSON.parse(await readFile(path, 'utf8')).entries[0].externalEffectStarted).toBe(true);
      throw new Error('remote timeout');
    })).rejects.toThrow('remote timeout');
    expect(() => journal.assertNoUnresolvedPreparation('pista-1')).toThrow('preparación interrumpida');
    expect(() => journal.assertNoUnresolvedPreparation('pista-2')).not.toThrow();
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    expect(() => restarted.assertNoUnresolvedPreparation('pista-1')).toThrow('preparación interrumpida');
  });

  it('reconciles a persisted configuration without repeating its mutation', async () => {
    const { journal, path } = await fixture();
    const input = Object.fromEntries(Object.entries(configuration).filter(([key]) => key !== 'updatedAt'));
    const id = randomUUID();
    await journal.execute(id, context, input, async () => configuration);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.entries[0].operation.status = 'pending';
    saved.entries[0].result = null;
    await writeFile(path, JSON.stringify(saved));
    const restarted = new PilotOperationJournal(path);
    await restarted.initialize();
    await restarted.reconcileConfigurations([{ ...configuration, homeTeam: 'Otro equipo' }]);
    expect(restarted.list()[0]?.status).toBe('interrupted');
    await restarted.reconcileConfigurations([configuration]);
    const action = vi.fn(async () => configuration);
    expect(await restarted.execute(id, context, input, action)).toEqual(configuration);
    expect(action).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt storage and does not run actions if intent cannot be written', async () => {
    const { path } = await fixture();
    await writeFile(path, '{broken');
    await expect(new PilotOperationJournal(path).initialize()).rejects.toThrow('registro');
    const journal = new PilotOperationJournal(`${path}/invalid`);
    const action = vi.fn(async () => configuration);
    await expect(journal.execute(randomUUID(), context, {}, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });
});
