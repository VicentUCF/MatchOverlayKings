import { CourtProgramProfileSchema } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { fingerprintProfile, reconcileOutput } from '../src/index.js';
import { profile, reconcileInput, runtime } from './fixtures.js';

function matchingRuntime(given: ReturnType<typeof reconcileInput>) {
  const desiredProfile = CourtProgramProfileSchema.parse(given.desired.desired.profile);
  return runtime(fingerprintProfile(desiredProfile), given.desired.version);
}

describe('reconcileOutput', () => {
  it.each(['running', 'preflight'])(
    'returns start given %s is desired when no runtime exists',
    (lifecycle) => {
      const base = reconcileInput();
      const given = {
        ...base,
        desired: { ...base.desired, desired: { ...base.desired.desired, lifecycle } },
      };

      const result = reconcileOutput(given);

      expect(result.action).toMatchObject({ kind: 'start', reason: 'runtime-absent' });
      expect(result.action.kind === 'start' ? result.action.target.output.name : '').toBe(
        'Court program',
      );
    },
  );

  it.each(['off', 'stopped'])(
    'returns noop given %s is desired when no runtime exists',
    (lifecycle) => {
      const base = reconcileInput();
      const given = {
        ...base,
        desired: { ...base.desired, desired: { ...base.desired.desired, lifecycle } },
      };

      const result = reconcileOutput(given);

      expect(result.action).toEqual({ kind: 'noop', reason: 'desired-inactive' });
    },
  );

  it.each(['off', 'stopped'])(
    'returns stop given %s is desired when a runtime exists',
    (lifecycle) => {
      const base = reconcileInput();
      const given = {
        ...base,
        desired: { ...base.desired, desired: { ...base.desired.desired, lifecycle } },
        observed: { ...base.observed, health: 'failed' },
        runtime: matchingRuntime(base),
      };

      const result = reconcileOutput(given);

      expect(result.action).toMatchObject({ kind: 'stop', reason: 'desired-inactive' });
    },
  );

  it.each(['running', 'preflight'])(
    'returns noop given %s is desired when the matching runtime is healthy',
    (lifecycle) => {
      const base = reconcileInput();
      const given = {
        ...base,
        desired: { ...base.desired, desired: { ...base.desired.desired, lifecycle } },
        runtime: matchingRuntime(base),
      };

      const result = reconcileOutput(given);

      expect(result.action).toEqual({ kind: 'noop', reason: 'runtime-healthy' });
    },
  );

  it('returns restart given an active runtime applied an older desired version', () => {
    const base = reconcileInput();
    const desiredProfile = CourtProgramProfileSchema.parse(profile());
    const given = { ...base, runtime: runtime(fingerprintProfile(desiredProfile), 2) };

    const result = reconcileOutput(given);

    expect(result.action).toMatchObject({ kind: 'restart', reason: 'desired-version-changed' });
  });

  it('returns restart given an active runtime applied a different profile', () => {
    const base = reconcileInput();
    const previousProfile = CourtProgramProfileSchema.parse({
      ...profile(),
      videoBitrateKbps: 7_500,
    });
    const given = { ...base, runtime: runtime(fingerprintProfile(previousProfile)) };

    const result = reconcileOutput(given);

    expect(result.action).toMatchObject({ kind: 'restart', reason: 'profile-changed' });
  });

  it.each([
    ['healthy', 'healthy'],
    ['unknown', 'unknown'],
    ['degraded', 'degraded'],
    ['failed', 'failed'],
    ['offline', 'offline'],
    ['no observation', null],
  ] as const)(
    'returns noop given a matching inspected runtime and %s observed health',
    (_label, health) => {
      const base = reconcileInput();
      const given = {
        ...base,
        observed: health === null ? null : { ...base.observed, health },
        runtime: matchingRuntime(base),
      };

      const result = reconcileOutput(given);

      expect(result.action).toEqual({ kind: 'noop', reason: 'runtime-healthy' });
    },
  );

  it('returns start given failed observed health but no local runtime', () => {
    const base = reconcileInput();
    const given = { ...base, observed: { ...base.observed, health: 'failed' } };

    const result = reconcileOutput(given);

    expect(result.action).toMatchObject({ kind: 'start', reason: 'runtime-absent' });
  });

  it('returns the same result for repeated identical input', () => {
    const base = reconcileInput();
    const given = { ...base, runtime: matchingRuntime(base) };

    const firstResult = reconcileOutput(given);
    const secondResult = reconcileOutput(given);

    expect(secondResult).toEqual(firstResult);
  });

  it.each(['output', 'desired', 'observed'])(
    'rejects malformed incoming %s data at the schema boundary',
    (field) => {
      const base = reconcileInput();
      const given = { ...base, [field]: { invalid: true } };

      const reconcileMalformedInput = () => reconcileOutput(given);

      expect(reconcileMalformedInput).toThrow(ZodError);
    },
  );

  it('rejects desired state for a different output at the per-output boundary', () => {
    const base = reconcileInput();
    const given = {
      ...base,
      desired: { ...base.desired, outputId: '10000000-0000-4000-8000-000000000002' },
    };

    const reconcileMismatchedOutput = () => reconcileOutput(given);

    expect(reconcileMismatchedOutput).toThrow(ZodError);
  });
});
