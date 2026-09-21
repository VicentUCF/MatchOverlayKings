import type { PilotMobileRuntimeCode } from '@kpl/production-contracts';

/** Only safe identifiers and enum causes leave the camera runtime. */
export type PilotMobileRuntimeEvent = {
  readonly id: string;
  readonly courtSlug: string;
  readonly mobileSessionId: string;
  readonly code: PilotMobileRuntimeCode;
  readonly attempt: number;
  readonly createdAt: string;
};
