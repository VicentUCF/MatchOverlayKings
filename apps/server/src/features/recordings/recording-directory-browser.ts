import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface RecordingDirectoryListing {
  readonly current: string;
  readonly parent: string | null;
  readonly directories: readonly { readonly name: string; readonly path: string }[];
}

export async function browseRecordingDirectories(
  dataDirectory: string,
  requestedPath?: string,
): Promise<RecordingDirectoryListing> {
  const defaultDirectory = resolve(dataDirectory, 'recordings');
  if (requestedPath === undefined) await mkdir(defaultDirectory, { recursive: true });

  const candidate = requestedPath ?? defaultDirectory;
  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    throw new TypeError('La carpeta debe ser una ruta absoluta del equipo de emisión.');
  }

  let current: string;
  try {
    current = await realpath(candidate);
    if (!(await stat(current)).isDirectory()) throw new TypeError('La ruta no es una carpeta.');
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('La carpeta ya no existe o no está disponible.');
  }

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    throw new TypeError('No se puede abrir esta carpeta. Revisa sus permisos.');
  }

  const parentPath = dirname(current);
  return Object.freeze({
    current,
    parent: parentPath === current ? null : parentPath,
    directories: Object.freeze(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => Object.freeze({ name: entry.name, path: join(current, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'es', { sensitivity: 'base' }))),
  });
}
