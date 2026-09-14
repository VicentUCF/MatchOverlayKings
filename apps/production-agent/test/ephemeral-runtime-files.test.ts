import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EphemeralRuntimeFilesError,
  NodeEphemeralRuntimeFiles,
  type EphemeralRuntimeCleanupRecovery,
  type EphemeralRuntimeFilesOptions,
} from '../src/ephemeral-runtime-files.js';
import { isTrustedAncestor } from '../src/local-secret-path-trust.js';

const CONFIG_YAML = 'api: yes\napiAddress: 127.0.0.1:9997\n';

class InjectedWriteError extends Error {}

function options(rootPath: string): EphemeralRuntimeFilesOptions {
  return {
    rootPath,
    directoryMode: 0o700,
    fileMode: 0o600,
    configYaml: CONFIG_YAML,
  };
}

async function withPrivateRoot<Result>(
  test: (rootPath: string) => Promise<Result>,
): Promise<Result> {
  const rootPath = await mkdtemp(join(tmpdir(), 'kpl-agent-runtime-'));
  await chmod(rootPath, 0o700);
  try {
    return await test(rootPath);
  } finally {
    await chmod(rootPath, 0o700).catch((error: unknown) => {
      if (isMissing(error)) return;
      throw error;
    });
    await rm(rootPath, { force: true, recursive: true });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function hasCleanupRecovery(
  value: unknown,
): value is EphemeralRuntimeFilesError & EphemeralRuntimeCleanupRecovery {
  return value instanceof EphemeralRuntimeFilesError
    && 'retryCleanup' in value
    && typeof value.retryCleanup === 'function';
}

describe('POSIX ephemeral MediaMTX runtime files', () => {
  it('rejects a relative root with a typed static error', async () => {
    // Given
    const runtimeFiles = new NodeEphemeralRuntimeFiles();

    // When
    const creation = runtimeFiles.create(options('relative/runtime'));

    // Then
    await expect(creation).rejects.toEqual(new EphemeralRuntimeFilesError('INVALID_ROOT'));
  });

  it('rejects a platform without an effective user ID', async () => {
    // Given
    const descriptor = Object.getOwnPropertyDescriptor(process, 'geteuid');
    if (descriptor === undefined) throw new InjectedWriteError('Expected POSIX process metadata');
    Reflect.deleteProperty(process, 'geteuid');
    try {
      // When
      const creation = new NodeEphemeralRuntimeFiles().create(options('/tmp'));

      // Then
      await expect(creation).rejects.toEqual(new EphemeralRuntimeFilesError('INVALID_ROOT'));
    } finally {
      Object.defineProperty(process, 'geteuid', descriptor);
    }
  });

  it('rejects a root whose mode is not exactly 0700', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      await chmod(rootPath, 0o750);

      // When
      const creation = new NodeEphemeralRuntimeFiles().create(options(rootPath));

      // Then
      await expect(creation).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    });
  });

  it('rejects a symlink used as the trusted root', async () => {
    await withPrivateRoot(async (containerPath) => {
      // Given
      const realRootPath = join(containerPath, 'real');
      const linkedRootPath = join(containerPath, 'linked');
      await mkdir(realRootPath, { mode: 0o700 });
      await symlink(realRootPath, linkedRootPath);

      // When
      const creation = new NodeEphemeralRuntimeFiles().create(options(linkedRootPath));

      // Then
      await expect(creation).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    });
  });

  it('rejects a writable non-sticky ancestor', async () => {
    await withPrivateRoot(async (containerPath) => {
      // Given
      const ancestorPath = join(containerPath, 'writable');
      const rootPath = join(ancestorPath, 'runtime');
      await mkdir(rootPath, { mode: 0o700, recursive: true });
      await chmod(ancestorPath, 0o770);
      try {
        // When
        const creation = new NodeEphemeralRuntimeFiles().create(options(rootPath));

        // Then
        await expect(creation).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      } finally {
        await chmod(ancestorPath, 0o700);
      }
    });
  });

  it('accepts the sticky tmp ancestor and creates exact private artifacts', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      const effectiveUserId = process.geteuid?.() ?? -1;
      expect((await lstat(tmpdir())).mode & 0o1000).toBe(0o1000);

      // When
      const artifact = await new NodeEphemeralRuntimeFiles().create(options(rootPath));

      // Then
      const directoryStats = await lstat(dirname(artifact.configPath));
      const configStats = await lstat(artifact.configPath);
      expect(directoryStats.isDirectory()).toBe(true);
      expect(directoryStats.uid).toBe(effectiveUserId);
      expect(directoryStats.mode & 0o7777).toBe(0o700);
      expect(configStats.isFile()).toBe(true);
      expect(configStats.uid).toBe(effectiveUserId);
      expect(configStats.mode & 0o7777).toBe(0o600);
      expect(await readFile(artifact.configPath, 'utf8')).toBe(CONFIG_YAML);
      expect(Object.isFrozen(artifact)).toBe(true);
      await artifact.cleanup();
    });
  });

  it('uses a unique private child for every creation', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      const runtimeFiles = new NodeEphemeralRuntimeFiles();

      // When
      const [first, second] = await Promise.all([
        runtimeFiles.create(options(rootPath)),
        runtimeFiles.create(options(rootPath)),
      ]);

      // Then
      expect(dirname(first.configPath)).not.toBe(dirname(second.configPath));
      await Promise.all([first.cleanup(), second.cleanup()]);
    });
  });

  it('resolves repeated cleanup after removing only its artifact', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      const artifact = await new NodeEphemeralRuntimeFiles().create(options(rootPath));
      const childPath = dirname(artifact.configPath);

      // When
      await artifact.cleanup();
      await artifact.cleanup();

      // Then
      await expect(lstat(childPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('cleans up when the known config file is already missing', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      const artifact = await new NodeEphemeralRuntimeFiles().create(options(rootPath));
      const childPath = dirname(artifact.configPath);
      await unlink(artifact.configPath);

      // When
      await artifact.cleanup();

      // Then
      await expect(lstat(childPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('retains cleanup ownership when an extra file prevents directory removal', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      const artifact = await new NodeEphemeralRuntimeFiles().create(options(rootPath));
      const childPath = dirname(artifact.configPath);
      const extraPath = join(childPath, 'preexisting');
      await writeFile(extraPath, 'leave me');

      // When
      const firstCleanup = artifact.cleanup();

      // Then
      await expect(firstCleanup).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
      await unlink(extraPath);
      await artifact.cleanup();
    });
  });

  it('rolls back a partial write and maps the failure without leaking details', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      const runtimeFiles = new NodeEphemeralRuntimeFiles(async (handle) => {
        await handle.write('x');
        throw new InjectedWriteError('private write detail');
      });

      // When
      const creation = runtimeFiles.create(options(rootPath));

      // Then
      await expect(creation).rejects.toEqual(new EphemeralRuntimeFilesError('IO_ERROR'));
      await expect(creation).rejects.not.toThrow(CONFIG_YAML);
      await expect(creation).rejects.not.toThrow('private write detail');
      await expect(creation).rejects.not.toHaveProperty('retryCleanup');
      expect(await readdir(rootPath)).toEqual([]);
    });
  });

  it('returns an opaque idempotent recovery when create rollback is blocked', async () => {
    await withPrivateRoot(async (rootPath) => {
      // Given
      let blockerPath = '';
      const runtimeFiles = new NodeEphemeralRuntimeFiles(async (handle) => {
        const configPath = await readlink(`/proc/self/fd/${handle.fd}`);
        blockerPath = join(dirname(configPath), 'rollback-blocker');
        await writeFile(blockerPath, 'blocked');
        throw new InjectedWriteError('private rollback detail');
      });

      // When
      const failure: unknown = await runtimeFiles.create(options(rootPath)).then(
        () => undefined,
        (error: unknown) => error,
      );

      // Then
      expect(failure).toMatchObject({ code: 'CLEANUP_FAILED' });
      expect(String(failure)).not.toContain(rootPath);
      expect(String(failure)).not.toContain(CONFIG_YAML);
      expect(String(failure)).not.toContain('private rollback detail');
      expect(JSON.stringify(failure)).not.toContain(rootPath);
      expect(JSON.stringify(failure)).not.toContain(CONFIG_YAML);
      expect(JSON.stringify(failure)).not.toContain('private rollback detail');
      expect(failure).not.toHaveProperty('cause');
      if (!hasCleanupRecovery(failure)) {
        throw new InjectedWriteError('Expected cleanup recovery capability');
      }
      await unlink(blockerPath);
      await failure.retryCleanup();
      await failure.retryCleanup();
      expect(await readdir(rootPath)).toEqual([]);
    });
  });

  it('classifies synthetic foreign ownership as untrusted', () => {
    // Given
    const effectiveUserId = 1000;

    // When
    const trusted = isTrustedAncestor({ uid: 2000, mode: 0o755 }, effectiveUserId);

    // Then
    expect(trusted).toBe(false);
  });
});
