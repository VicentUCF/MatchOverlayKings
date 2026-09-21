import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  LocalSecretRefSchema,
  type LocalSecretRef,
} from '@kpl/production-contracts';
import { isTrustedAncestor } from './local-secret-path-trust.js';

const LOCAL_PREFIX = 'local://';
const MAX_SECRET_BYTES = 65_536;
const REDACTED = '[REDACTED]';
const GROUP_OR_OTHER_PERMISSIONS = 0o077;
const GROUP_OR_OTHER_WRITE = 0o022;

export type LocalSecretResolverErrorCode =
  | 'DIRECTORY'
  | 'DISPOSED'
  | 'EMPTY'
  | 'INVALID_REFERENCE'
  | 'INVALID_ROOT'
  | 'IO_ERROR'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'UNSAFE_PATH';

const errorMessages = {
  DIRECTORY: 'Secret target must be a regular file',
  DISPOSED: 'Secret material has been disposed',
  EMPTY: 'Secret file is empty',
  INVALID_REFERENCE: 'Invalid local secret reference',
  INVALID_ROOT: 'Invalid local secret root',
  IO_ERROR: 'Unable to read local secret',
  NOT_FOUND: 'Local secret not found',
  TOO_LARGE: 'Secret file exceeds the size limit',
  UNSAFE_PATH: 'Unsafe local secret path',
} as const satisfies Record<LocalSecretResolverErrorCode, string>;

export class LocalSecretResolverError extends Error {
  public readonly code: LocalSecretResolverErrorCode;

  public constructor(code: LocalSecretResolverErrorCode) {
    super(errorMessages[code]);
    this.name = 'LocalSecretResolverError';
    this.code = code;
  }
}

export interface ResolvedSecret {
  readonly withBytes: <Result>(
    consumer: (bytes: Uint8Array) => Result | Promise<Result>,
  ) => Promise<Result>;
  readonly dispose: () => void;
  readonly toJSON: () => string;
  readonly toString: () => string;
}

class MutableResolvedSecret implements ResolvedSecret {
  readonly #bytes: Uint8Array;
  #disposed = false;

  public constructor(bytes: Uint8Array) {
    this.#bytes = Uint8Array.from(bytes);
  }

  public async withBytes<Result>(
    consumer: (bytes: Uint8Array) => Result | Promise<Result>,
  ): Promise<Result> {
    if (this.#disposed) throw new LocalSecretResolverError('DISPOSED');
    const copy = Uint8Array.from(this.#bytes);
    try {
      return await consumer(copy);
    } finally {
      copy.fill(0);
    }
  }

  public dispose(): void {
    this.#bytes.fill(0);
    this.#disposed = true;
  }

  public toJSON(): string {
    return REDACTED;
  }

  public toString(): string {
    return REDACTED;
  }
}

export class LocalSecretResolver {
  readonly #rootPath: string;

  public constructor(rootPath: string) {
    if (!isAbsolute(rootPath)) throw new LocalSecretResolverError('INVALID_ROOT');
    this.#rootPath = rootPath;
  }

  public async resolve(referenceInput: LocalSecretRef): Promise<ResolvedSecret> {
    const parsedReference = LocalSecretRefSchema.safeParse(referenceInput);
    if (!parsedReference.success) throw new LocalSecretResolverError('INVALID_REFERENCE');
    const pathSegments = parsedReference.data.slice(LOCAL_PREFIX.length).split('/');
    if (pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new LocalSecretResolverError('UNSAFE_PATH');
    }
    const candidatePath = resolve(this.#rootPath, ...pathSegments);
    if (!isContained(this.#rootPath, candidatePath)) {
      throw new LocalSecretResolverError('UNSAFE_PATH');
    }

    try {
      const rootStats = await lstat(this.#rootPath);
      if (rootStats.isSymbolicLink()) throw new LocalSecretResolverError('UNSAFE_PATH');
      if (!rootStats.isDirectory() || rootStats.uid !== getEffectiveUserId()
        || (rootStats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
        throw new LocalSecretResolverError('INVALID_ROOT');
      }
      await assertTrustedAncestors(this.#rootPath);
      let currentPath = this.#rootPath;
      for (const [index, segment] of pathSegments.entries()) {
        currentPath = join(currentPath, segment);
        const stats = await lstat(currentPath);
        if (stats.isSymbolicLink()) {
          throw new LocalSecretResolverError('UNSAFE_PATH');
        }
        const isTarget = index === pathSegments.length - 1;
        if (!isTarget && (!stats.isDirectory() || (stats.mode & GROUP_OR_OTHER_WRITE) !== 0)) {
          throw new LocalSecretResolverError('UNSAFE_PATH');
        }
        if (isTarget && !stats.isFile()) throw new LocalSecretResolverError('DIRECTORY');
        if (isTarget && (stats.uid !== getEffectiveUserId()
          || (stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0)) {
          throw new LocalSecretResolverError('UNSAFE_PATH');
        }
      }
      const canonicalRoot = await realpath(this.#rootPath);
      const canonicalPath = await realpath(candidatePath);
      if (!isContained(canonicalRoot, canonicalPath)) {
        throw new LocalSecretResolverError('UNSAFE_PATH');
      }
      return await readSecret(canonicalPath);
    } catch (error) {
      if (error instanceof LocalSecretResolverError) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new LocalSecretResolverError('NOT_FOUND');
      }
      throw new LocalSecretResolverError('IO_ERROR');
    }
  }
}

async function readSecret(canonicalPath: string): Promise<ResolvedSecret> {
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new LocalSecretResolverError('DIRECTORY');
    if (stats.uid !== getEffectiveUserId() || (stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
      throw new LocalSecretResolverError('UNSAFE_PATH');
    }
    if (stats.size === 0) throw new LocalSecretResolverError('EMPTY');
    if (stats.size > MAX_SECRET_BYTES) throw new LocalSecretResolverError('TOO_LARGE');
    const readBuffer = new Uint8Array(MAX_SECRET_BYTES + 1);
    let byteLength = 0;
    while (byteLength < readBuffer.byteLength) {
      const { bytesRead } = await handle.read(
        readBuffer,
        byteLength,
        readBuffer.byteLength - byteLength,
        byteLength,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
    }
    if (byteLength === 0) throw new LocalSecretResolverError('EMPTY');
    if (byteLength > MAX_SECRET_BYTES) {
      readBuffer.fill(0);
      throw new LocalSecretResolverError('TOO_LARGE');
    }
    const bytes = readBuffer.slice(0, byteLength);
    readBuffer.fill(0);
    return new MutableResolvedSecret(bytes);
  } finally {
    await handle.close();
  }
}

async function assertTrustedAncestors(rootPath: string): Promise<void> {
  let ancestorPath = dirname(rootPath);
  while (true) {
    const stats = await lstat(ancestorPath);
    if (stats.isSymbolicLink()) throw new LocalSecretResolverError('UNSAFE_PATH');
    if (!isTrustedAncestor(stats, getEffectiveUserId())) {
      throw new LocalSecretResolverError('UNSAFE_PATH');
    }
    const parentPath = dirname(ancestorPath);
    if (parentPath === ancestorPath) return;
    ancestorPath = parentPath;
  }
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function getEffectiveUserId(): number {
  const getUserId = process.geteuid;
  if (getUserId === undefined) throw new LocalSecretResolverError('INVALID_ROOT');
  return getUserId();
}
