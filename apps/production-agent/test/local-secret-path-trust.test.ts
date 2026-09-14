import { describe, expect, it } from 'vitest';
import { isTrustedAncestor } from '../src/local-secret-path-trust.js';

const EFFECTIVE_USER_ID = 1000;

describe('POSIX ancestor trust', () => {
  it.each([
    ['different-UID 0755', { uid: 2000, mode: 0o755 }, false],
    ['different-UID 1777', { uid: 2000, mode: 0o1777 }, false],
    ['root-owned 0755', { uid: 0, mode: 0o755 }, true],
    ['root-owned 1777', { uid: 0, mode: 0o1777 }, true],
    ['root-owned 0777', { uid: 0, mode: 0o777 }, false],
    ['effective-UID-owned 0755', { uid: EFFECTIVE_USER_ID, mode: 0o755 }, true],
    ['effective-UID-owned 0770', { uid: EFFECTIVE_USER_ID, mode: 0o770 }, false],
  ])('returns the documented decision for %s', (_label, metadata, expected) => {
    const trusted = isTrustedAncestor(metadata, EFFECTIVE_USER_ID);

    expect(trusted).toBe(expected);
  });
});
