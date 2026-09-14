import {
  OutputIdSchema,
  VersionSchema,
  type DesiredOutputState,
  type Output,
  type OutputId,
  type Version,
} from '@kpl/production-contracts';
import { z } from 'zod';
import {
  CourtSnapshotObjectSchema,
  validateSnapshotIdentity,
} from './config.js';

export const ProfileFingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<'ProfileFingerprint'>();

export const PipelineRuntimeSchema = z
  .strictObject({
    outputId: OutputIdSchema,
    appliedDesiredVersion: VersionSchema,
    profileFingerprint: ProfileFingerprintSchema,
  })
  .readonly();

export const ReconcileInputSchema = z
  .strictObject({
    ...CourtSnapshotObjectSchema.shape,
    runtime: PipelineRuntimeSchema.nullable(),
  })
  .superRefine((input, context) => {
    validateSnapshotIdentity(input, context);
    if (input.runtime !== null && input.runtime.outputId !== input.output.id) {
      context.addIssue({ code: 'custom', path: ['runtime', 'outputId'], message: 'Output mismatch' });
    }
  })
  .readonly();

export type ProfileFingerprint = z.infer<typeof ProfileFingerprintSchema>;
export type PipelineRuntime = z.infer<typeof PipelineRuntimeSchema>;
export type ReconcileInput = z.infer<typeof ReconcileInputSchema>;

export type PipelineTarget = {
  readonly output: Output;
  readonly desired: DesiredOutputState;
  readonly profileFingerprint: ProfileFingerprint;
};

export type ReconciliationAction =
  | {
      readonly kind: 'start';
      readonly reason: 'runtime-absent';
      readonly target: PipelineTarget;
    }
  | {
      readonly kind: 'stop';
      readonly reason: 'desired-inactive';
      readonly runtime: PipelineRuntime;
    }
  | {
      readonly kind: 'restart';
      readonly reason: 'desired-version-changed' | 'profile-changed' | 'runtime-unhealthy';
      readonly runtime: PipelineRuntime;
      readonly target: PipelineTarget;
    }
  | {
      readonly kind: 'noop';
      readonly reason: 'desired-inactive' | 'runtime-healthy';
    };

export type StartAction = Extract<ReconciliationAction, { readonly kind: 'start' }>;
export type StopAction = Extract<ReconciliationAction, { readonly kind: 'stop' }>;
export type RestartAction = Extract<ReconciliationAction, { readonly kind: 'restart' }>;

export type ReconciliationResult = {
  readonly outputId: OutputId;
  readonly desiredVersion: Version;
  readonly desiredProfileFingerprint: ProfileFingerprint;
  readonly action: ReconciliationAction;
};
