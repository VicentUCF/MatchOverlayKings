import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LocalSecretRefSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { LocalSecretResolver } from '../src/local-secret-resolver.js';

async function withSecretRoot<Result>(
  test: (rootPath: string) => Promise<Result>,
): Promise<Result> {
  const rootPath = await mkdtemp(join(tmpdir(), 'kpl-agent-secrets-'));
  await chmod(rootPath, 0o700);
  try {
    return await test(rootPath);
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
}

async function writeSecret(path: string, contents: string | Uint8Array): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
}

describe('LocalSecretResolver', () => {
  it('reads bytes asynchronously and redacts material until disposal', async () => {
    await withSecretRoot(async (rootPath) => {
      await mkdir(join(rootPath, 'outputs'));
      await writeSecret(join(rootPath, 'outputs', 'program'), 'top-secret-value');
      const resolver = new LocalSecretResolver(rootPath);
      const secret = await resolver.resolve(LocalSecretRefSchema.parse('local://outputs/program'));
      let observed = '';
      let borrowedBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();

      await secret.withBytes((bytes) => {
        observed = new TextDecoder().decode(bytes);
        borrowedBytes = bytes;
      });

      expect(observed).toBe('top-secret-value');
      expect(borrowedBytes.every((byte) => byte === 0)).toBe(true);
      expect(String(secret)).toBe('[REDACTED]');
      expect(`${secret}`).toBe('[REDACTED]');
      expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
      secret.dispose();
      await expect(secret.withBytes(() => undefined)).rejects.toMatchObject({ code: 'DISPOSED' });
    });
  });

  it('maps a missing target to a bounded error', async () => {
    await withSecretRoot(async (rootPath) => {
      const resolver = new LocalSecretResolver(rootPath);

      const resolution = resolver.resolve(LocalSecretRefSchema.parse('local://missing'));

      await expect(resolution).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it.each([
    ['local://safe/../outside', 'UNSAFE_PATH'],
    ['local:///absolute', 'INVALID_REFERENCE'],
    ['local://safe/%2e%2e/outside', 'INVALID_REFERENCE'],
    ['local://safe/\0outside', 'INVALID_REFERENCE'],
  ])('rejects unsafe reference %s without exposing it', async (reference, code) => {
    await withSecretRoot(async (rootPath) => {
      const resolver = new LocalSecretResolver(rootPath);

      const resolution = Reflect.apply(resolver.resolve, resolver, [reference]);

      await expect(resolution).rejects.toMatchObject({ code });
      await expect(resolution).rejects.not.toThrow(reference);
    });
  });

  it('rejects a symlinked target and an ancestor escaping the root', async () => {
    await withSecretRoot(async (rootPath) => {
      const outsidePath = await mkdtemp(join(tmpdir(), 'kpl-agent-outside-'));
      try {
        await writeSecret(join(outsidePath, 'secret'), 'outside-secret');
        await symlink(join(outsidePath, 'secret'), join(rootPath, 'target-link'));
        await symlink(outsidePath, join(rootPath, 'ancestor-link'));
        const resolver = new LocalSecretResolver(rootPath);

        await expect(resolver.resolve(
          LocalSecretRefSchema.parse('local://target-link'),
        )).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
        await expect(resolver.resolve(
          LocalSecretRefSchema.parse('local://ancestor-link/secret'),
        )).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      } finally {
        await rm(outsidePath, { force: true, recursive: true });
      }
    });
  });

  it('rejects a symlink used as the configured root', async () => {
    await withSecretRoot(async (containerPath) => {
      const realRootPath = join(containerPath, 'real-root');
      const linkedRootPath = join(containerPath, 'linked-root');
      await mkdir(realRootPath, { mode: 0o700 });
      await writeSecret(join(realRootPath, 'target'), 'secret');
      await symlink(realRootPath, linkedRootPath);

      const resolution = new LocalSecretResolver(linkedRootPath).resolve(
        LocalSecretRefSchema.parse('local://target'),
      );

      await expect(resolution).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    });
  });

  it('rejects a root with group or other permissions', async () => {
    await withSecretRoot(async (rootPath) => {
      await writeSecret(join(rootPath, 'target'), 'secret');
      await chmod(rootPath, 0o750);

      const resolution = new LocalSecretResolver(rootPath).resolve(
        LocalSecretRefSchema.parse('local://target'),
      );

      await expect(resolution).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    });
  });

  it('rejects a secret file with group or other permissions', async () => {
    await withSecretRoot(async (rootPath) => {
      const targetPath = join(rootPath, 'target');
      await writeSecret(targetPath, 'secret');
      await chmod(targetPath, 0o640);

      const resolution = new LocalSecretResolver(rootPath).resolve(
        LocalSecretRefSchema.parse('local://target'),
      );

      await expect(resolution).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    });
  });

  it('rejects a group-writable directory inside the secret root', async () => {
    await withSecretRoot(async (rootPath) => {
      const directoryPath = join(rootPath, 'outputs');
      await mkdir(directoryPath, { mode: 0o770 });
      await chmod(directoryPath, 0o770);
      await writeSecret(join(directoryPath, 'target'), 'secret');

      const resolution = new LocalSecretResolver(rootPath).resolve(
        LocalSecretRefSchema.parse('local://outputs/target'),
      );

      await expect(resolution).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    });
  });

  it('rejects an effective-UID-owned writable non-sticky ancestor above the root', async () => {
    await withSecretRoot(async (containerPath) => {
      const writableAncestorPath = join(containerPath, 'writable-ancestor');
      const rootPath = join(writableAncestorPath, 'secrets');
      await mkdir(rootPath, { mode: 0o700, recursive: true });
      await chmod(writableAncestorPath, 0o770);
      await writeSecret(join(rootPath, 'target'), 'secret');

      const resolution = new LocalSecretResolver(rootPath).resolve(
        LocalSecretRefSchema.parse('local://target'),
      );

      await expect(resolution).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    });
  });

  it('rejects a filesystem socket before attempting to read it', async () => {
    await withSecretRoot(async (rootPath) => {
      const socketPath = join(rootPath, 'socket');
      const server = createServer();
      server.listen(socketPath);
      await once(server, 'listening');
      try {
        const resolution = new LocalSecretResolver(rootPath).resolve(
          LocalSecretRefSchema.parse('local://socket'),
        );

        await expect(resolution).rejects.toMatchObject({ code: 'DIRECTORY' });
      } finally {
        server.close();
        await once(server, 'close');
      }
    });
  });

  it.each([
    ['directory', 'DIRECTORY', null],
    ['empty file', 'EMPTY', new Uint8Array()],
    ['oversized file', 'TOO_LARGE', new Uint8Array(65_537)],
  ])('rejects a %s target', async (_label, code, contents) => {
    await withSecretRoot(async (rootPath) => {
      const targetPath = join(rootPath, 'target');
      if (contents === null) await mkdir(targetPath);
      else await writeSecret(targetPath, contents);
      const resolver = new LocalSecretResolver(rootPath);

      const resolution = resolver.resolve(LocalSecretRefSchema.parse('local://target'));

      await expect(resolution).rejects.toMatchObject({ code });
    });
  });
});
