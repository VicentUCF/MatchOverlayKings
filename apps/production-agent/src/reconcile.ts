import type { ObservedHealth } from '@kpl/production-contracts';
import { fingerprintProfile } from './fingerprint.js';
import {
  ReconcileInputSchema,
  type PipelineRuntime,
  type PipelineTarget,
  type ReconciliationAction,
  type ReconciliationResult,
} from './models.js';

type RuntimeHealth = ObservedHealth | 'unreported';

class UnexpectedReconciliationVariantError extends Error {
  public constructor() {
    super('Unexpected reconciliation variant');
    this.name = 'UnexpectedReconciliationVariantError';
  }
}

export function reconcileOutput(input: unknown): ReconciliationResult {
  const parsedInput = ReconcileInputSchema.parse(input);
  const profileFingerprint = fingerprintProfile(parsedInput.desired.desired.profile);
  const target: PipelineTarget = {
    output: parsedInput.output,
    desired: parsedInput.desired,
    profileFingerprint,
  };
  const action: ReconciliationAction = (() => {
    switch (parsedInput.desired.desired.lifecycle) {
      case 'running':
      case 'preflight':
        return reconcileActiveRuntime(
          parsedInput.runtime,
          parsedInput.observed?.health ?? 'unreported',
          target,
        );
      case 'off':
      case 'stopped':
        return parsedInput.runtime === null
          ? { kind: 'noop', reason: 'desired-inactive' }
          : { kind: 'stop', reason: 'desired-inactive', runtime: parsedInput.runtime };
      default:
        return assertNever(parsedInput.desired.desired.lifecycle);
    }
  })();

  return {
    outputId: parsedInput.output.id,
    desiredVersion: parsedInput.desired.version,
    desiredProfileFingerprint: profileFingerprint,
    action,
  };
}

function reconcileActiveRuntime(
  runtime: PipelineRuntime | null,
  health: RuntimeHealth,
  target: PipelineTarget,
): ReconciliationAction {
  if (runtime === null) {
    return { kind: 'start', reason: 'runtime-absent', target };
  }
  if (runtime.appliedDesiredVersion !== target.desired.version) {
    return { kind: 'restart', reason: 'desired-version-changed', runtime, target };
  }
  if (runtime.profileFingerprint !== target.profileFingerprint) {
    return { kind: 'restart', reason: 'profile-changed', runtime, target };
  }

  switch (health) {
    case 'healthy':
      return { kind: 'noop', reason: 'runtime-healthy' };
    case 'unknown':
    case 'degraded':
    case 'failed':
    case 'offline':
    case 'unreported':
      return { kind: 'restart', reason: 'runtime-unhealthy', runtime, target };
    default:
      return assertNever(health);
  }
}

function assertNever(value: never): never {
  void value;
  throw new UnexpectedReconciliationVariantError();
}
