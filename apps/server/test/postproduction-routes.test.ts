import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostproductionControlSnapshotSchema, PostproductionOperatorAccessSchema } from '@kpl/production-contracts';
import { createInitialMatchState, type Team } from '@kpl/shared';
import { buildApp } from '../src/bootstrap/app.js';
import type { PilotOverlayRenderer } from '../src/features/pilot/pilot-overlay.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('postproduction operator routes', () => {
  it('uses a tokenized usual control link and records commands at the reported playhead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kpl-postproduction-routes-'));
    const dataDir = join(root, 'data'); const sourceRoot = join(root, 'source'); const outputRoot = join(root, 'output');
    await mkdir(dataDir); await mkdir(sourceRoot); await mkdir(outputRoot);
    const sourcePath = join(sourceRoot, 'match.mp4');
    await execFileAsync('/usr/bin/ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30',
      '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourcePath,
    ]);
    await writeFile(join(dataDir, 'teams.json'), JSON.stringify(teams));
    const { app } = await buildApp({
      host: '127.0.0.1', port: 4310, dataDir, postproductionSourceRoot: sourceRoot,
      postproductionOutputRoot: outputRoot, webDistDir: join(root, 'missing-web'), controlPin: null,
      pilot: { ffmpegPath: '/usr/bin/ffmpeg', youtube: { clientId: null, clientSecret: null, redirectUri: null, tokenPath: null } },
    }, {
      pilotOverlayRenderer: { start: vi.fn(), close: vi.fn() } as unknown as PilotOverlayRenderer,
      productionAccessGuard: { require: async () => undefined },
    });
    cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
    const initialState = createInitialMatchState({
      id: crypto.randomUUID(), title: 'Grabado', homeTeamId: 'home', awayTeamId: 'away',
      lineups: { home: { player1: 'A', player2: 'B' }, away: { player1: 'C', player2: 'D' } },
      servingSide: 'home', courtName: 'Pista 1', status: 'live',
      config: { setsToWin: 2, gamesPerSet: 6, tieBreakAt: 6, tieBreakTarget: 7, tieBreakWinBy: 2, deuceMode: 'golden-point' },
    });
    const created = await app.inject({ method: 'POST', url: '/api/pilot/postproduction/projects', payload: {
      sourcePath: 'match.mp4', title: 'Grabado', seasonLabel: '2026', matchdayNumber: 1,
      courtSlug: 'pista-1', initialState, teams, leagueSnapshot: null,
    } });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id as string;
    const accessResponse = await app.inject({ method: 'POST', url: `/api/pilot/postproduction/projects/${projectId}/operator-access` });
    const access = PostproductionOperatorAccessSchema.parse(accessResponse.json());
    expect(access.controlUrl).toContain(`/control/postproduction-${projectId}#token=`);
    const token = new URL(access.controlUrl).hash.slice('#token='.length);

    expect((await app.inject({ method: 'GET', url: `/api/postproduction-control/${projectId}/state` })).statusCode).toBe(401);
    await app.inject({ method: 'PUT', url: `/api/pilot/postproduction/projects/${projectId}/playhead`, payload: { playheadMs: 250 } });
    const stateResponse = await app.inject({ method: 'GET', url: `/api/postproduction-control/${projectId}/state`, headers: { authorization: `Bearer ${token}` } });
    const snapshot = PostproductionControlSnapshotSchema.parse(stateResponse.json());
    const command = await app.inject({ method: 'POST', url: `/api/postproduction-control/${projectId}/command`,
      headers: { authorization: `Bearer ${token}` }, payload: {
        expectedVersion: (snapshot.state as unknown as { version: number }).version,
        commandId: crypto.randomUUID(), kind: 'add_point', payload: { side: 'home' },
      } });
    const updated = PostproductionControlSnapshotSchema.parse(command.json());
    expect(command.statusCode).toBe(200);
    expect((updated.state as unknown as { currentGame: { homePoints: number } }).currentGame.homePoints).toBe(1);
    expect(updated.playheadMs).toBe(250);
  }, 15_000);
});

const teams: Team[] = [
  { id: 'home', name: 'Local', shortName: 'LOC', logoUrl: '', primaryColor: '#000000', secondaryColor: '#ffffff' },
  { id: 'away', name: 'Visitante', shortName: 'VIS', logoUrl: '', primaryColor: '#ffffff', secondaryColor: '#000000' },
];
