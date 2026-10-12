import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { PilotAudioInput, PilotSource } from '@kpl/production-contracts';

export type WindowsDevices = { readonly cameras: readonly PilotSource[]; readonly audioInputs: readonly PilotAudioInput[] };

export function parseDirectShowDevices(output: string): WindowsDevices {
  const cameras: PilotSource[] = [];
  const audioInputs: PilotAudioInput[] = [];
  let pending: { label: string; kind: 'video' | 'audio' } | null = null;
  const add = (label: string, kind: 'video' | 'audio', deviceName: string) => {
    const hash = createHash('sha256').update(`${kind}\0${deviceName}`).digest('hex');
    if (kind === 'video') cameras.push({ id: `dshow:${hash}`, kind: 'dshow', label, deviceName });
    else audioInputs.push({ id: `dshow-audio:${hash}`, label, deviceName });
  };
  for (const line of output.split(/\r?\n/)) {
    const device = line.match(/\]\s+"([^"]+)"\s+\((video|audio)\)/);
    if (device) {
      if (pending) add(pending.label, pending.kind, pending.label);
      pending = { label: device[1]!, kind: device[2]! as 'video' | 'audio' };
      continue;
    }
    const alternative = line.match(/\]\s+Alternative name\s+"([^"]+)"/);
    if (alternative && pending) {
      add(pending.label, pending.kind, alternative[1]!);
      pending = null;
    }
  }
  if (pending) add(pending.label, pending.kind, pending.label);
  return { cameras, audioInputs };
}

export function discoverWindowsDevices(ffmpegPath: string, platform = process.platform): WindowsDevices {
  if (platform !== 'win32') return { cameras: [], audioInputs: [] };
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: 512 * 1024 });
  return parseDirectShowDevices(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
}
