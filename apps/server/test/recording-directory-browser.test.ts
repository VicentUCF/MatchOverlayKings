import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browseRecordingDirectories } from '../src/recording-directory-browser.js';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('recording directory browser', () => {
  it('opens the real default directory and lists only child folders', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'kpl-directory-browser-'));
    cleanups.push(dataDirectory);
    await mkdir(join(dataDirectory, 'recordings', 'Pista B'), { recursive: true });
    await mkdir(join(dataDirectory, 'recordings', 'pista a'));
    await writeFile(join(dataDirectory, 'recordings', 'part-1.mp4'), 'video');

    const listing = await browseRecordingDirectories(dataDirectory);

    expect(listing).toEqual({
      current: resolve(dataDirectory, 'recordings'),
      parent: resolve(dataDirectory),
      directories: [
        { name: 'pista a', path: resolve(dataDirectory, 'recordings', 'pista a') },
        { name: 'Pista B', path: resolve(dataDirectory, 'recordings', 'Pista B') },
      ],
    });
  });

  it('rejects relative, missing and non-directory paths', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'kpl-directory-browser-'));
    cleanups.push(dataDirectory);
    const filePath = join(dataDirectory, 'not-a-folder');
    await writeFile(filePath, 'x');

    await expect(browseRecordingDirectories(dataDirectory, 'recordings')).rejects.toThrow('ruta absoluta');
    await expect(browseRecordingDirectories(dataDirectory, join(dataDirectory, 'missing'))).rejects.toThrow('no existe');
    await expect(browseRecordingDirectories(dataDirectory, filePath)).rejects.toThrow('no es una carpeta');
  });
});
