import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Commit a private snapshot before allowing the next external side effect. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value)}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
