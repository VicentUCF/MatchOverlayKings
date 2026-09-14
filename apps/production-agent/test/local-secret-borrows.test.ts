import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSecretRefSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { LocalSecretResolver } from '../src/local-secret-resolver.js';
import { deferred } from './fake-support.js';

async function withSecret<Result>(
  test: (resolver: LocalSecretResolver) => Promise<Result>,
): Promise<Result> {
  const rootPath = await mkdtemp(join(tmpdir(), 'kpl-agent-secret-borrows-'));
  await chmod(rootPath, 0o700);
  await writeFile(join(rootPath, 'target'), 'canonical-value', { mode: 0o600 });
  try {
    return await test(new LocalSecretResolver(rootPath));
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
}

describe('resolved secret borrows', () => {
  it('keeps sequential borrows independent when a consumer mutates its bytes', async () => {
    await withSecret(async (resolver) => {
      const secret = await resolver.resolve(LocalSecretRefSchema.parse('local://target'));

      await secret.withBytes((bytes) => bytes.fill(0x78));
      const observed = await secret.withBytes((bytes) => new TextDecoder().decode(bytes));

      expect(observed).toBe('canonical-value');
    });
  });

  it('keeps overlapping borrows independent and zeroizes each completed borrow', async () => {
    await withSecret(async (resolver) => {
      const secret = await resolver.resolve(LocalSecretRefSchema.parse('local://target'));
      const firstStarted = deferred();
      const releaseFirst = deferred();
      let firstBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
      const firstBorrow = secret.withBytes(async (bytes) => {
        firstBytes = bytes;
        bytes.fill(0x78);
        firstStarted.resolve();
        await releaseFirst.promise;
      });
      await firstStarted.promise;

      const secondObserved = await secret.withBytes((bytes) => new TextDecoder().decode(bytes));
      releaseFirst.resolve();
      await firstBorrow;

      expect(secondObserved).toBe('canonical-value');
      expect(firstBytes.every((byte) => byte === 0)).toBe(true);
    });
  });

  it('disposes canonical material without invalidating an active independent borrow', async () => {
    await withSecret(async (resolver) => {
      const secret = await resolver.resolve(LocalSecretRefSchema.parse('local://target'));
      const borrowStarted = deferred();
      const releaseBorrow = deferred();
      let observed = '';
      const activeBorrow = secret.withBytes(async (bytes) => {
        borrowStarted.resolve();
        await releaseBorrow.promise;
        observed = new TextDecoder().decode(bytes);
      });
      await borrowStarted.promise;

      secret.dispose();
      const futureBorrow = expect(secret.withBytes(() => undefined)).rejects.toMatchObject({
        code: 'DISPOSED',
      });
      releaseBorrow.resolve();
      await activeBorrow;

      expect(observed).toBe('canonical-value');
      await futureBorrow;
    });
  });
});
