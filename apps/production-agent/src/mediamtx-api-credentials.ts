import { createHash } from 'node:crypto';

const RANDOM_BYTES = 24;
const REDACTED = '[REDACTED]';

export interface RandomBytesPort {
  readonly randomBytes: (size: number) => Uint8Array;
}

export type MediaMtxApiPlannerCredentials = {
  readonly username: string;
  readonly passwordHash: string;
};

export interface MediaMtxApiCredentials {
  readonly planner: () => MediaMtxApiPlannerCredentials;
  readonly withBasicAuthorization: <Result>(
    consumer: (authorization: string) => Result | Promise<Result>,
  ) => Promise<Result>;
  readonly dispose: () => void;
  readonly toJSON: () => string;
  readonly toString: () => string;
}

export interface MediaMtxApiCredentialFactoryPort {
  readonly create: () => MediaMtxApiCredentials;
}

export type MediaMtxApiCredentialsErrorCode = 'DISPOSED';

const errorMessages = {
  DISPOSED: 'MediaMTX API credentials have been disposed',
} as const satisfies Record<MediaMtxApiCredentialsErrorCode, string>;

export class MediaMtxApiCredentialsError extends Error {
  public constructor(public readonly code: MediaMtxApiCredentialsErrorCode) {
    super(errorMessages[code]);
    this.name = 'MediaMtxApiCredentialsError';
  }
}

class MutableMediaMtxApiCredentials implements MediaMtxApiCredentials {
  readonly #planner: MediaMtxApiPlannerCredentials;
  readonly #clearPassword: Uint8Array;
  #disposed = false;

  public constructor(username: string, clearPassword: Uint8Array) {
    this.#clearPassword = clearPassword;
    this.#planner = Object.freeze({
      username,
      passwordHash: `sha256:${createHash('sha256').update(clearPassword).digest('base64')}`,
    });
  }

  public planner(): MediaMtxApiPlannerCredentials {
    return this.#planner;
  }

  public async withBasicAuthorization<Result>(
    consumer: (authorization: string) => Result | Promise<Result>,
  ): Promise<Result> {
    if (this.#disposed) throw new MediaMtxApiCredentialsError('DISPOSED');
    const username = Buffer.from(this.#planner.username, 'ascii');
    const combined = Buffer.alloc(username.byteLength + 1 + this.#clearPassword.byteLength);
    try {
      combined.set(username);
      combined[username.byteLength] = 0x3a;
      combined.set(this.#clearPassword, username.byteLength + 1);
      return await consumer(`Basic ${combined.toString('base64')}`);
    } finally {
      username.fill(0);
      combined.fill(0);
    }
  }

  public dispose(): void {
    this.#clearPassword.fill(0);
    this.#disposed = true;
  }

  public toJSON(): string {
    return REDACTED;
  }

  public toString(): string {
    return REDACTED;
  }
}

export function createMediaMtxApiCredentials(random: RandomBytesPort): MediaMtxApiCredentials {
  const usernameBytes = random.randomBytes(RANDOM_BYTES);
  const username = Buffer.from(usernameBytes).toString('hex');
  usernameBytes.fill(0);
  const passwordBytes = random.randomBytes(RANDOM_BYTES);
  const clearPassword = encodeLowercaseHex(passwordBytes);
  passwordBytes.fill(0);
  return new MutableMediaMtxApiCredentials(username, clearPassword);
}

export class MediaMtxApiCredentialFactory implements MediaMtxApiCredentialFactoryPort {
  public constructor(private readonly random: RandomBytesPort) {}

  public create = (): MediaMtxApiCredentials => createMediaMtxApiCredentials(this.random);
}

export function isMediaMtxApiCredentials(value: unknown): value is MediaMtxApiCredentials {
  return value instanceof MutableMediaMtxApiCredentials;
}

function encodeLowercaseHex(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.byteLength * 2);
  for (const [index, byte] of bytes.entries()) {
    const high = byte >>> 4;
    const low = byte & 0x0f;
    output[index * 2] = high < 10 ? 0x30 + high : 0x61 + high - 10;
    output[(index * 2) + 1] = low < 10 ? 0x30 + low : 0x61 + low - 10;
  }
  return output;
}
