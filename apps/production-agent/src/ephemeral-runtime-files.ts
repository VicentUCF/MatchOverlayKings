import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isTrustedAncestor } from './local-secret-path-trust.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o7777;
const CONFIG_FILE_NAME = 'mediamtx.yml';

export type EphemeralRuntimeFilesOptions = {
  readonly rootPath: string;
  readonly directoryMode: typeof DIRECTORY_MODE;
  readonly fileMode: typeof FILE_MODE;
  readonly configYaml: string;
};

export type EphemeralRuntimeArtifact = {
  readonly configPath: string;
  readonly cleanup: () => Promise<void>;
};

export interface EphemeralRuntimeFilesPort {
  create(options: EphemeralRuntimeFilesOptions): Promise<EphemeralRuntimeArtifact>;
}

export type EphemeralRuntimeFilesErrorCode =
  | 'CLEANUP_FAILED'
  | 'INVALID_ROOT'
  | 'IO_ERROR'
  | 'UNSAFE_PATH';

const errorMessages = {
  CLEANUP_FAILED: 'Unable to clean up ephemeral runtime files',
  INVALID_ROOT: 'Invalid ephemeral runtime root',
  IO_ERROR: 'Unable to create ephemeral runtime files',
  UNSAFE_PATH: 'Unsafe ephemeral runtime path',
} as const satisfies Record<EphemeralRuntimeFilesErrorCode, string>;

type OwnedPaths = {
  readonly directoryPath: string;
  readonly configPath: string;
};

type ConfigWriter = (handle: FileHandle, configYaml: string) => Promise<void>;

export interface EphemeralRuntimeCleanupRecovery {
  readonly code: 'CLEANUP_FAILED';
  readonly retryCleanup: () => Promise<void>;
}

export function isEphemeralRuntimeCleanupRecovery(
  value: unknown,
): value is EphemeralRuntimeCleanupRecovery {
  return value instanceof Error
    && 'code' in value
    && value.code === 'CLEANUP_FAILED'
    && 'retryCleanup' in value
    && typeof value.retryCleanup === 'function';
}

export class EphemeralRuntimeFilesError<
  Code extends EphemeralRuntimeFilesErrorCode = EphemeralRuntimeFilesErrorCode,
> extends Error {
  public readonly code: Code;

  public constructor(code: Code) {
    super(errorMessages[code]);
    this.name = 'EphemeralRuntimeFilesError';
    this.code = code;
  }
}

class CleanupFailedError
  extends EphemeralRuntimeFilesError<'CLEANUP_FAILED'>
  implements EphemeralRuntimeCleanupRecovery {
  readonly #ownedPaths: OwnedPaths;
  #cleaned = false;

  public constructor(ownedPaths: OwnedPaths) {
    super('CLEANUP_FAILED');
    this.#ownedPaths = ownedPaths;
  }

  public readonly retryCleanup = async (): Promise<void> => {
    if (this.#cleaned) return;
    if (!await removeOwnedPaths(this.#ownedPaths)) throw this;
    this.#cleaned = true;
  };
}

export class NodeEphemeralRuntimeFiles implements EphemeralRuntimeFilesPort {
  readonly #writeConfig: ConfigWriter;

  public constructor(writeConfig: ConfigWriter = writeFullyAndSync) {
    this.#writeConfig = writeConfig;
  }

  public async create(options: EphemeralRuntimeFilesOptions): Promise<EphemeralRuntimeArtifact> {
    if (!isAbsolute(options.rootPath)
      || options.directoryMode !== DIRECTORY_MODE
      || options.fileMode !== FILE_MODE) {
      throw new EphemeralRuntimeFilesError('INVALID_ROOT');
    }
    const effectiveUserId = getEffectiveUserId();
    let ownedPaths: OwnedPaths | undefined;
    let handle: FileHandle | undefined;
    let closeFailed = false;
    try {
      await assertTrustedRoot(options.rootPath, effectiveUserId);
      const directoryPath = await mkdtemp(join(options.rootPath, 'mediamtx-'));
      ownedPaths = { directoryPath, configPath: join(directoryPath, CONFIG_FILE_NAME) };
      await chmod(directoryPath, options.directoryMode);
      await assertOwnedDirectory(directoryPath, effectiveUserId, options.directoryMode);
      handle = await open(
        ownedPaths.configPath,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        options.fileMode,
      );
      await handle.chmod(options.fileMode);
      await assertOwnedFile(handle, effectiveUserId, options.fileMode);
      await this.#writeConfig(handle, options.configYaml);
      await handle.close();
      handle = undefined;
      return createArtifact(ownedPaths);
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          closeFailed = true;
        }
      }
      if (ownedPaths !== undefined && !await removeOwnedPaths(ownedPaths)) {
        throw cleanupError(ownedPaths);
      }
      if (closeFailed) throw new EphemeralRuntimeFilesError('IO_ERROR');
      if (error instanceof EphemeralRuntimeFilesError) throw error;
      throw new EphemeralRuntimeFilesError('IO_ERROR');
    }
  }
}

function getEffectiveUserId(): number {
  const getUserId = process.geteuid;
  if (getUserId === undefined) throw new EphemeralRuntimeFilesError('INVALID_ROOT');
  return getUserId();
}

async function assertTrustedRoot(rootPath: string, effectiveUserId: number): Promise<void> {
  let rootStats;
  try {
    rootStats = await lstat(rootPath);
  } catch (error) {
    if (isMissing(error)) throw new EphemeralRuntimeFilesError('INVALID_ROOT');
    throw new EphemeralRuntimeFilesError('IO_ERROR');
  }
  if (rootStats.isSymbolicLink()) throw new EphemeralRuntimeFilesError('UNSAFE_PATH');
  if (!rootStats.isDirectory()
    || rootStats.uid !== effectiveUserId
    || (rootStats.mode & MODE_MASK) !== DIRECTORY_MODE) {
    throw new EphemeralRuntimeFilesError('INVALID_ROOT');
  }
  let ancestorPath = dirname(rootPath);
  while (true) {
    const stats = await lstat(ancestorPath);
    if (stats.isSymbolicLink() || !isTrustedAncestor(stats, effectiveUserId)) {
      throw new EphemeralRuntimeFilesError('UNSAFE_PATH');
    }
    const parentPath = dirname(ancestorPath);
    if (parentPath === ancestorPath) return;
    ancestorPath = parentPath;
  }
}

async function assertOwnedDirectory(
  directoryPath: string,
  effectiveUserId: number,
  mode: typeof DIRECTORY_MODE,
): Promise<void> {
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== effectiveUserId
    || (stats.mode & MODE_MASK) !== mode) {
    throw new EphemeralRuntimeFilesError('UNSAFE_PATH');
  }
}

async function assertOwnedFile(
  handle: FileHandle,
  effectiveUserId: number,
  mode: typeof FILE_MODE,
): Promise<void> {
  const stats = await handle.stat();
  if (!stats.isFile() || stats.uid !== effectiveUserId || (stats.mode & MODE_MASK) !== mode) {
    throw new EphemeralRuntimeFilesError('UNSAFE_PATH');
  }
}

async function writeFullyAndSync(handle: FileHandle, configYaml: string): Promise<void> {
  const bytes = Buffer.from(configYaml, 'utf8');
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten === 0) throw new EphemeralRuntimeFilesError('IO_ERROR');
    offset += result.bytesWritten;
  }
  await handle.sync();
}

function createArtifact(ownedPaths: OwnedPaths): EphemeralRuntimeArtifact {
  let cleaned = false;
  return Object.freeze({
    configPath: ownedPaths.configPath,
    cleanup: async () => {
      if (cleaned) return;
      if (!await removeOwnedPaths(ownedPaths)) {
        throw cleanupError(ownedPaths);
      }
      cleaned = true;
    },
  });
}

async function removeOwnedPaths(ownedPaths: OwnedPaths): Promise<boolean> {
  let removed = true;
  try {
    await unlink(ownedPaths.configPath);
  } catch (error) {
    if (!isMissing(error)) removed = false;
  }
  try {
    await rmdir(ownedPaths.directoryPath);
  } catch (error) {
    if (!isMissing(error)) removed = false;
  }
  return removed;
}

function cleanupError(ownedPaths: OwnedPaths): EphemeralRuntimeFilesError<'CLEANUP_FAILED'> & EphemeralRuntimeCleanupRecovery {
  return new CleanupFailedError(ownedPaths);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
