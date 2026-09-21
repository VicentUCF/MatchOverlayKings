import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PostproductionSourceListing } from '@kpl/production-contracts';

export async function browsePostproductionSources(rootPath: string, requestedPath?: string): Promise<PostproductionSourceListing> {
  const root = await realpath(rootPath).catch(() => { throw new TypeError('La carpeta de vídeos de renovación no está disponible.'); });
  const relativePath = requestedPath?.trim() || '';
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new TypeError('La ruta del vídeo no es válida.');
  const candidate = resolve(root, relativePath);
  const current = await realpath(candidate).catch(() => { throw new TypeError('La carpeta ya no existe.'); });
  assertInside(root, current);
  if (!(await stat(current)).isDirectory()) throw new TypeError('La ruta no es una carpeta.');
  const entries = await readdir(current, { withFileTypes: true });
  const directories: PostproductionSourceListing['directories'][number][] = [];
  const files: PostproductionSourceListing['files'][number][] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    let resolved: string;
    try { resolved = await realpath(path); assertInside(root, resolved); } catch { continue; }
    if (entry.isDirectory()) directories.push({ name: entry.name, path: slash(relative(root, resolved)) });
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
      files.push({ name: entry.name, path: slash(relative(root, resolved)), sizeBytes: (await stat(resolved)).size });
    }
  }
  const parentRelative = relative(root, current);
  return {
    current: slash(parentRelative),
    parent: parentRelative === '' ? null : slash(relative(root, resolve(current, '..'))),
    directories: directories.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })),
    files: files.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })),
  };
}

export async function resolvePostproductionSource(rootPath: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0')) throw new TypeError('La ruta del vídeo no es válida.');
  const root = await realpath(rootPath);
  const resolved = await realpath(resolve(root, relativePath));
  assertInside(root, resolved);
  const info = await stat(resolved);
  if (!info.isFile() || !resolved.toLowerCase().endsWith('.mp4')) throw new TypeError('Selecciona un archivo MP4 válido.');
  return resolved;
}

function assertInside(root: string, candidate: string): void {
  const child = relative(resolve(root), resolve(candidate));
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new TypeError('La ruta está fuera de la carpeta permitida.');
}

function slash(value: string): string { return value.split(sep).join('/'); }
