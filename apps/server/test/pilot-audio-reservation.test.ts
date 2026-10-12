import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { PilotSource, PilotAudioInput, PreparePilotSessionInput } from '@kpl/production-contracts';
import { PilotService } from '../src/features/pilot/pilot-service.js';
import { PilotYouTubeGateway } from '../src/features/pilot/pilot-youtube.js';

it('reserves a Windows microphone for one prepared recording until that session stops', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kpl-audio-reservation-'));
  const cameras: PilotSource[] = [1, 2].map((number) => ({
    id: `dshow:${String(number).repeat(64)}`, kind: 'dshow', label: `Camera ${number}`, deviceName: `@camera-${number}`,
  }));
  const microphone: PilotAudioInput = { id: `dshow-audio:${'a'.repeat(64)}`, label: 'USB mic', deviceName: '@mic' };
  const identity = { homeTeamId: 'kings', awayTeamId: 'lions', overlayToken: 'b'.repeat(64) };
  const service = new PilotService('/bin/ffmpeg', new PilotYouTubeGateway({
    clientId: null, clientSecret: null, redirectUri: null, tokenPath: null,
  }), join(directory, 'configurations.json'), undefined, undefined,
  { configure: async () => identity, assertConfigured: async () => identity }, undefined, undefined, {}, undefined,
  { recordingOnly: true });
  try {
    await service.initialize();
    (service as unknown as { windowsDevices: { cameras: PilotSource[]; audioInputs: PilotAudioInput[] } }).windowsDevices
      = { cameras, audioInputs: [microphone] };
    const input = (courtSlug: string, sourceId: string): PreparePilotSessionInput => ({
      courtSlug, mode: 'recording', sourceId, homeTeam: 'Kings', awayTeam: 'Lions',
      matchdayNumber: 1, seasonLabel: 'T2', scheduledAt: '2099-01-01T10:00:00.000Z', privacyStatus: 'private',
      audioInputs: [{ id: microphone.id, gain: 1 }],
    });
    const firstInput = input('pista-1', cameras[0]!.id);
    const secondInput = input('pista-2', cameras[1]!.id);
    await service.configure('pista-1', firstInput);
    await service.configure('pista-2', secondInput);
    const first = await service.prepare(firstInput);
    await expect(service.prepare(secondInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.stop(first.id);
    await expect(service.prepare(secondInput)).resolves.toMatchObject({ courtSlug: 'pista-2', status: 'prepared' });
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
