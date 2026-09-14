import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMediaMtxApiCredentials,
  type RandomBytesPort,
} from '../src/mediamtx-api-credentials.js';

function deterministicBytes(...values: readonly number[]): RandomBytesPort {
  let next = 0;
  return {
    randomBytes: (size) => {
      const value = values[next];
      next += 1;
      if (value === undefined) throw new Error('Missing deterministic bytes');
      return new Uint8Array(size).fill(value);
    },
  };
}

describe('MediaMTX API credentials', () => {
  it('creates deterministic planner credentials and borrows Basic authorization', async () => {
    // Given
    const requestedSizes: number[] = [];
    const credentials = createMediaMtxApiCredentials({
      randomBytes: (size) => {
        requestedSizes.push(size);
        return new Uint8Array(size).fill(requestedSizes.length === 1 ? 0xab : 0xcd);
      },
    });
    const clearPassword = 'cd'.repeat(24);

    // When
    const planner = credentials.planner();
    const authorization = await credentials.withBasicAuthorization((header) => header);

    // Then
    expect(planner).toEqual({
      username: 'ab'.repeat(24),
      passwordHash: `sha256:${createHash('sha256').update(clearPassword).digest('base64')}`,
    });
    expect(requestedSizes).toEqual([24, 24]);
    expect(authorization).toBe(`Basic ${Buffer.from(`${planner.username}:${clearPassword}`).toString('base64')}`);
  });

  it('redacts representation and rejects future borrows after idempotent disposal', async () => {
    // Given
    const credentials = createMediaMtxApiCredentials(deterministicBytes(0x33, 0x44));

    // When
    credentials.dispose();
    credentials.dispose();

    // Then
    expect(credentials.toString()).toBe('[REDACTED]');
    expect(JSON.stringify(credentials)).toBe('"[REDACTED]"');
    await expect(credentials.withBasicAuthorization(() => undefined)).rejects.toMatchObject({
      code: 'DISPOSED',
    });
  });
});
