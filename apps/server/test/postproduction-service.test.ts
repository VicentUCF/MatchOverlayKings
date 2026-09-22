import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialMatchState, type MatchState, type Team } from '@kpl/shared';
import { PostproductionService } from '../src/features/postproduction/postproduction-service.js';
import type { PilotOverlayRenderer } from '../src/features/pilot/pilot-overlay.js';
import type { RecordingLibrary } from '../src/features/recordings/recording-library.js';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PostproductionService', () => {
  it('deletes an editing project while preserving its original video', async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create(createInput('match.mp4'));
    const projectPath = join(fixture.dataRoot, 'postproduction', 'projects', `${project.id}.json`);

    await fixture.service.deleteProject(project.id);

    expect(fixture.service.list()).toEqual([]);
    expect(() => fixture.service.get(project.id)).toThrow('No existe ese proyecto');
    await expect(readFile(projectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.sourceRoot, 'match.mp4'))).resolves.toBeDefined();
  });

  it('replays and persists a completed-game checkpoint', async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create(createInput('match.mp4'));
    const actions = [100, 200, 300, 400].map((timestampMs) => ({
      id: randomUUID(), timestampMs, kind: 'add_point' as const, payload: { side: 'home' as const },
    }));

    const saved = await fixture.service.checkpoint(project.id, {
      expectedRevision: project.revision, playheadMs: 400, actions, reason: 'game',
    });

    expect((saved.checkpoint.state as unknown as MatchState).sets[0]?.homeGames).toBe(1);
    expect(saved.checkpoint.reason).toBe('game');
    const disk = JSON.parse(await readFile(join(fixture.dataRoot, 'postproduction', 'projects', `${project.id}.json`), 'utf8')) as { revision: number };
    expect(disk.revision).toBe(2);
  });

  it('only relinks a source with the original fingerprint', async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create(createInput('match.mp4'));
    await mkdir(join(fixture.sourceRoot, 'moved'));
    await copyFile(join(fixture.sourceRoot, 'match.mp4'), join(fixture.sourceRoot, 'moved', 'same.mp4'));

    const relinked = await fixture.service.relink(project.id, { sourcePath: 'moved/same.mp4' });

    expect(relinked.source.relativePath).toBe('moved/same.mp4');
    expect(relinked.revision).toBe(2);
    await writeFile(join(fixture.sourceRoot, 'different.mp4'), 'different-video');
    await expect(fixture.service.relink(project.id, { sourcePath: 'different.mp4' }))
      .rejects.toThrow('no coincide con la huella');
  });

  it('records commands from the usual operator control at the current video position', async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create(createInput('match.mp4'));
    const access = fixture.service.issueOperatorAccess(project.id);
    fixture.service.updatePlayhead(project.id, { playheadMs: 4_250 });

    let snapshot = fixture.service.operatorSnapshot(project.id, access.token);
    for (let index = 0; index < 4; index += 1) {
      snapshot = await fixture.service.operatorCommand(project.id, access.token, {
        expectedVersion: (snapshot.state as unknown as MatchState).version,
        commandId: randomUUID(), kind: 'add_point', payload: { side: 'home' },
      });
    }

    const saved = fixture.service.get(project.id);
    expect(saved.checkpoint.actions).toHaveLength(4);
    expect(saved.checkpoint.actions.every(({ timestampMs }) => timestampMs === 4_250)).toBe(true);
    expect((saved.checkpoint.state as unknown as MatchState).sets[0]?.homeGames).toBe(1);
    expect(saved.checkpoint.reason).toBe('game');
    expect(snapshot.playheadMs).toBe(4_250);
    expect(() => fixture.service.operatorSnapshot(project.id, '0'.repeat(64))).toThrow('no es válido');
  });

  it('renders a short synthetic MP4 through a temporary file and registers the result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kpl-postproduction-render-'));
    temporaryDirectories.push(root);
    const dataRoot = join(root, 'data'); const sourceRoot = join(root, 'source'); const outputRoot = join(root, 'device-output');
    await mkdir(dataRoot); await mkdir(sourceRoot); await mkdir(outputRoot);
    const sourcePath = join(sourceRoot, 'short.mp4');
    await execFileAsync('/usr/bin/ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30',
      '-t', '0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourcePath,
    ]);
    const frame = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const renderer: PilotOverlayRenderer = {
      start: async (output, options, signal) => {
        output.on('error', () => undefined);
        options.onState?.({ status: 'ready', attempt: 0, lastFrameAt: new Date().toISOString(), holdingLastFrame: false, reason: null });
        while (!signal.aborted && !output.destroyed) {
          if (!output.write(frame)) await Promise.race([once(output, 'drain'), delay(100)]);
          await delay(15);
        }
      },
      close: async () => undefined,
    };
    const registerDerivedAsset = vi.fn(async () => ({ id: 'a'.repeat(64), state: 'ready', error: null }));
    const service = new PostproductionService(
      dataRoot, sourceRoot, outputRoot, '/usr/bin/ffmpeg', '/usr/bin/ffprobe', 'http://127.0.0.1:4310', join(root, 'missing.mp3'),
      renderer, { registerDerivedAsset } as unknown as RecordingLibrary, () => false,
    );
    await service.initialize();
    const project = await service.create(createInput('short.mp4'));

    await service.startRender(project.id);
    const completed = await waitForProject(service, project.id);

    expect(completed.status).toBe('ready');
    expect(registerDerivedAsset).toHaveBeenCalledOnce();
    await expect(readFile(join(outputRoot, `${project.id}.mp4`))).resolves.not.toHaveLength(0);
    await expect(readFile(join(outputRoot, `${project.id}.mp4.partial`))).rejects.toThrow();
    expect(registerDerivedAsset).toHaveBeenCalledWith(expect.objectContaining({
      path: join(outputRoot, `${project.id}.mp4`), storageRoot: outputRoot,
    }));
  }, 15_000);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kpl-postproduction-service-'));
  temporaryDirectories.push(root);
  const dataRoot = join(root, 'data');
  const sourceRoot = join(root, 'source');
  const outputRoot = join(root, 'output');
  await mkdir(dataRoot); await mkdir(sourceRoot); await mkdir(outputRoot);
  await writeFile(join(sourceRoot, 'match.mp4'), 'synthetic-video');
  const ffprobePath = join(root, 'ffprobe');
  await writeFile(ffprobePath, `#!/bin/sh
printf '%s' '{"format":{"duration":"12"},"streams":[{"codec_type":"video","width":1280,"height":720,"avg_frame_rate":"25/1"},{"codec_type":"audio"}]}'
`);
  await chmod(ffprobePath, 0o700);
  const renderer = { start: vi.fn(), close: vi.fn() } as unknown as PilotOverlayRenderer;
  const recordings = { registerDerivedAsset: vi.fn() } as unknown as RecordingLibrary;
  const service = new PostproductionService(
    dataRoot, sourceRoot, outputRoot, '/bin/false', ffprobePath, 'http://127.0.0.1:4310', join(root, 'missing.mp3'),
    renderer, recordings, () => false,
  );
  await service.initialize();
  return { service, dataRoot, sourceRoot };
}

const teams: Team[] = [
  { id: 'home', name: 'Local', shortName: 'LOC', logoUrl: '', primaryColor: '#000000', secondaryColor: '#ffffff' },
  { id: 'away', name: 'Visitante', shortName: 'VIS', logoUrl: '', primaryColor: '#ffffff', secondaryColor: '#000000' },
];

function createInput(sourcePath: string) {
  return {
    sourcePath, title: 'Partido de prueba', seasonLabel: '2026', matchdayNumber: 1, courtSlug: 'pista-1',
    initialState: createInitialMatchState({
      id: randomUUID(), title: 'Partido de prueba', homeTeamId: 'home', awayTeamId: 'away',
      lineups: { home: { player1: 'A', player2: 'B' }, away: { player1: 'C', player2: 'D' } },
      servingSide: 'home', courtName: 'Pista 1', status: 'live',
      config: { setsToWin: 2, gamesPerSet: 6, tieBreakAt: 6, tieBreakTarget: 7, tieBreakWinBy: 2, deuceMode: 'golden-point' },
    }),
    teams,
    leagueSnapshot: null,
  };
}

async function waitForProject(service: PostproductionService, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = service.get(id);
    if (project.status !== 'rendering') return project;
    await delay(100);
  }
  throw new Error('El render sintético no terminó a tiempo.');
}
