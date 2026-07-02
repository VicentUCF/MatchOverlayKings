import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import type { Ack, ClientToServerEvents, MatchState, ServerToClientEvents } from '@kpl/shared';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('socket integration', () => {
  let baseUrl = '';
  let closeApp: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    const dataDir = await createFixtureData();
    const { app } = await buildApp({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDistDir: join(dataDir, 'missing-web'),
      controlPin: null,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('No test server address.');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
    closeApp = async () => app.close();
  });

  afterEach(async () => {
    await closeApp?.();
    closeApp = null;
  });

  it('broadcasts scoring updates to overlay clients and rejects stale versions', async () => {
    const control = createSocket(baseUrl);
    const overlay = createSocket(baseUrl);
    const controlState = await emitAck(control, 'join:event', {
      eventId: 'demo',
      role: 'control',
    });
    await emitAck(overlay, 'join:event', {
      eventId: 'demo',
      role: 'overlay',
    });

    const updatedPromise = new Promise<MatchState>((resolve) => {
      overlay.on('state:updated', (payload) => resolve(payload.state));
    });
    const next = await emitAck(control, 'score:addPoint', {
      eventId: 'demo',
      side: 'home',
      expectedVersion: controlState.version,
      commandId: 'point-1',
    });
    const broadcast = await updatedPromise;

    expect(next.currentGame.homePoints).toBe(1);
    expect(broadcast.version).toBe(next.version);

    const stale = await emitRaw(control, 'score:addPoint', {
      eventId: 'demo',
      side: 'away',
      expectedVersion: controlState.version,
      commandId: 'point-stale',
    });

    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.error.code).toBe('VERSION_CONFLICT');

    control.close();
    overlay.close();
  });
});

async function createFixtureData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kpl-live-'));
  await mkdir(join(root, 'events'), { recursive: true });
  await writeFile(
    join(root, 'teams.json'),
    JSON.stringify([
      {
        id: 'home',
        name: 'Home',
        shortName: 'HOME',
        logoUrl: '/logos/home.png',
        primaryColor: '#ffffff',
        secondaryColor: '#000000',
      },
      {
        id: 'away',
        name: 'Away',
        shortName: 'AWAY',
        logoUrl: '/logos/away.png',
        primaryColor: '#ff0000',
        secondaryColor: '#000000',
      },
    ]),
    'utf8',
  );
  await writeFile(
    join(root, 'events', 'demo.json'),
    JSON.stringify({
      id: 'demo',
      title: 'Demo',
      homeTeamId: 'home',
      awayTeamId: 'away',
      courtName: 'Central',
      status: 'pre_match',
      config: {
        setsToWin: 2,
        gamesPerSet: 6,
        tieBreakAt: 6,
        tieBreakTarget: 7,
        tieBreakWinBy: 2,
        deuceMode: 'golden-point',
      },
      state: null,
    }),
    'utf8',
  );

  return root;
}

function createSocket(url: string): ClientSocket {
  return createClient(url, {
    transports: ['websocket'],
    forceNew: true,
  });
}

function emitAck<E extends keyof ClientToServerEvents>(
  socket: ClientSocket,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
): Promise<MatchState> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response: Ack<MatchState>) => {
      if (response.ok) {
        resolve(response.data);
      } else {
        reject(new Error(response.error.message));
      }
    });
  });
}

function emitRaw<E extends keyof ClientToServerEvents>(
  socket: ClientSocket,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
): Promise<Ack<MatchState>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: Ack<MatchState>) => resolve(response));
  });
}
