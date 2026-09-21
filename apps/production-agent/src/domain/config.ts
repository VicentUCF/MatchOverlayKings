import {
  CourtIdSchema,
  DesiredOutputStateSchema,
  ObservedOutputStateSchema,
  OutputSchema,
} from '@kpl/production-contracts';
import { z } from 'zod';

export const CourtWorkerConfigSchema = z.strictObject({ courtId: CourtIdSchema }).readonly();

const ConfiguredCourtsSchema = z
  .tuple([
    CourtWorkerConfigSchema,
    CourtWorkerConfigSchema,
    CourtWorkerConfigSchema,
    CourtWorkerConfigSchema,
  ])
  .readonly();

export const AgentConfigSchema = z
  .strictObject({
    courts: ConfiguredCourtsSchema,
    maxConcurrentPipelines: z.literal(3),
  })
  .superRefine((config, context) => {
    const uniqueCourtIds = new Set(config.courts.map((court) => court.courtId));
    if (uniqueCourtIds.size !== config.courts.length) {
      context.addIssue({ code: 'custom', path: ['courts'], message: 'Court IDs must be unique' });
    }
  })
  .readonly();

export const CourtSnapshotObjectSchema = z.strictObject({
  output: OutputSchema,
  desired: DesiredOutputStateSchema,
  observed: ObservedOutputStateSchema.nullable(),
});

export type CourtSnapshotObject = z.infer<typeof CourtSnapshotObjectSchema>;

export function validateSnapshotIdentity(
  snapshot: CourtSnapshotObject,
  context: z.RefinementCtx,
): void {
  if (snapshot.desired.outputId !== snapshot.output.id) {
    context.addIssue({ code: 'custom', path: ['desired', 'outputId'], message: 'Output mismatch' });
  }
  if (snapshot.desired.clubId !== snapshot.output.clubId) {
    context.addIssue({ code: 'custom', path: ['desired', 'clubId'], message: 'Club mismatch' });
  }
  if (snapshot.desired.eventId !== snapshot.output.eventId) {
    context.addIssue({ code: 'custom', path: ['desired', 'eventId'], message: 'Event mismatch' });
  }
  if (snapshot.desired.desired.profile.courtId !== snapshot.output.courtId) {
    context.addIssue({
      code: 'custom',
      path: ['desired', 'desired', 'profile', 'courtId'],
      message: 'Court mismatch',
    });
  }
  if (snapshot.observed !== null && snapshot.observed.outputId !== snapshot.output.id) {
    context.addIssue({ code: 'custom', path: ['observed', 'outputId'], message: 'Output mismatch' });
  }
  if (snapshot.observed !== null && snapshot.observed.clubId !== snapshot.output.clubId) {
    context.addIssue({ code: 'custom', path: ['observed', 'clubId'], message: 'Club mismatch' });
  }
  if (snapshot.observed !== null && snapshot.observed.eventId !== snapshot.output.eventId) {
    context.addIssue({ code: 'custom', path: ['observed', 'eventId'], message: 'Event mismatch' });
  }
}

export const CourtSnapshotSchema = CourtSnapshotObjectSchema
  .superRefine(validateSnapshotIdentity)
  .readonly();

export const SupervisorSnapshotsSchema = z
  .tuple([
    CourtSnapshotSchema,
    CourtSnapshotSchema,
    CourtSnapshotSchema,
    CourtSnapshotSchema,
  ])
  .readonly();

export type CourtWorkerConfig = z.infer<typeof CourtWorkerConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type CourtSnapshot = z.infer<typeof CourtSnapshotSchema>;
export type SupervisorSnapshots = z.infer<typeof SupervisorSnapshotsSchema>;
