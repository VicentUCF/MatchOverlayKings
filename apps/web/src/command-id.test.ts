import { describe, expect, it } from 'vitest';
import { createCommandId } from './command-id.js';

describe('createCommandId', () => {
  it('uses randomUUID when available', () => {
    expect(createCommandId({ randomUUID: () => 'native-id' })).toBe('native-id');
  });

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    const commandId = createCommandId({
      getRandomValues: ((bytes: Uint8Array) => {
        bytes.fill(0);
        return bytes;
      }) as Crypto['getRandomValues'],
    });

    expect(commandId).toBe('00000000-0000-4000-8000-000000000000');
  });
});
