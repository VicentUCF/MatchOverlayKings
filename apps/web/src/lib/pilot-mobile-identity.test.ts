import { afterEach, expect, it, vi } from 'vitest';
import { mobileClientIdentity } from './pilot-mobile-identity.js';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('preserves the camera owner across a page reload while isolating sessions and servers', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  const first = mobileClientIdentity('http://192.168.1.20:4310', 'court-session');
  vi.resetModules();
  const reloaded = await import('./pilot-mobile-identity.js');
  expect(reloaded.mobileClientIdentity('http://192.168.1.20:4310', 'court-session')).toBe(first);
  expect(reloaded.mobileClientIdentity('http://192.168.1.20:4310', 'other-session')).not.toBe(first);
  expect(reloaded.mobileClientIdentity('http://192.168.1.21:4310', 'court-session')).not.toBe(first);
  expect([...values.values()].every((value) => /^[a-f0-9-]{36}$/.test(value))).toBe(true);
});

it('retains ownership within the page when browser storage is blocked', () => {
  vi.stubGlobal('window', { get sessionStorage() { throw new Error('blocked'); } });
  const first = mobileClientIdentity('http://192.168.1.22:4310', 'blocked-session');
  expect(mobileClientIdentity('http://192.168.1.22:4310', 'blocked-session')).toBe(first);
});
