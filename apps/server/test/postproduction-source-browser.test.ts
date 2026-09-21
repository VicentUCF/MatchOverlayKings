import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browsePostproductionSources, resolvePostproductionSource } from '../src/features/postproduction/postproduction-source-browser.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('postproduction source browser', () => {
  it('lists only MP4 files and returns relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kpl-post-source-')); roots.push(root);
    await mkdir(join(root, 'Jornada 1'));
    await writeFile(join(root, 'Jornada 1', 'partido.mp4'), 'video');
    await writeFile(join(root, 'Jornada 1', 'notas.txt'), 'notes');
    const listing = await browsePostproductionSources(root, 'Jornada 1');
    expect(listing.current).toBe('Jornada 1');
    expect(listing.files).toEqual([{ name: 'partido.mp4', path: 'Jornada 1/partido.mp4', sizeBytes: 5 }]);
    expect(await resolvePostproductionSource(root, listing.files[0]!.path)).toBe(join(root, 'Jornada 1', 'partido.mp4'));
  });

  it('rejects traversal and hides symlinks that escape the mounted root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kpl-post-source-')); roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), 'kpl-post-outside-')); roots.push(outside);
    await writeFile(join(outside, 'secret.mp4'), 'secret');
    await symlink(join(outside, 'secret.mp4'), join(root, 'escaped.mp4'));
    await expect(resolvePostproductionSource(root, join('..', basename(outside), 'secret.mp4'))).rejects.toThrow('fuera');
    expect((await browsePostproductionSources(root)).files).toEqual([]);
  });
});
