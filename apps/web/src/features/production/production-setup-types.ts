import type {
  Device,
  Output,
  ProductionAssignment,
  ProductionEvent,
  ProductionEventDay,
} from '@kpl/production-contracts';
import type { ProductionCourtSlug } from './production-overview-types.js';

export type SetupPrincipal = {
  readonly id: string;
  readonly clubId: string;
  readonly authUserId: string;
  readonly kind: 'agent' | 'device';
  readonly displayName: string;
  readonly active: boolean;
  readonly version: number;
};

export type SetupCourt = {
  readonly id: string;
  readonly clubId: string;
  readonly slug: ProductionCourtSlug;
  readonly name: string;
  readonly displayOrder: number;
  readonly productionEnabled: boolean;
};

export type ProductionSetupInventory = {
  readonly eventDays: readonly ProductionEventDay[];
  readonly principals: readonly SetupPrincipal[];
  readonly devices: readonly Device[];
  readonly courts: readonly SetupCourt[];
  readonly events: readonly ProductionEvent[];
  readonly assignments: readonly ProductionAssignment[];
  readonly outputs: readonly Output[];
};

export type ProductionSetupInventoryLoadResult =
  | { readonly kind: 'success'; readonly inventory: ProductionSetupInventory }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'transport' };

export type ProductionSetupInventoryAdapter = {
  readonly load: (clubId: string) => Promise<ProductionSetupInventoryLoadResult>;
};

export type SetupCourtDraft = {
  readonly slug: ProductionCourtSlug;
  readonly devicePrincipalId: string;
  readonly deviceId: string;
  readonly eventId: string;
  readonly captureAssignmentId: string;
  readonly agentAssignmentId: string;
  readonly outputId: string;
  readonly captureAuthUserId: string;
  readonly captureRef: string;
  readonly outputRef: string;
  readonly title: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
};

export type ProductionSetupDraft = {
  readonly clubId: string;
  readonly eventDayId: string;
  readonly eventDayName: string;
  readonly eventDate: string;
  readonly timeZone: string;
  readonly agentPrincipalId: string;
  readonly agentAuthUserId: string;
  readonly courts: readonly SetupCourtDraft[];
};

export type SetupUnit = 'shared' | ProductionCourtSlug;
export type SetupProgressKind =
  | 'pending'
  | 'accepted'
  | 'validation'
  | 'forbidden'
  | 'conflict'
  | 'malformed'
  | 'transport';

export type SetupOperationProgress = {
  readonly unit: SetupUnit;
  readonly kind: SetupProgressKind;
};

export type SetupCourtCompletion = {
  readonly slug: ProductionCourtSlug;
  readonly complete: boolean;
  readonly acceptedParts: number;
  readonly totalParts: 7;
};

export type ProductionSetupCompletion = {
  readonly sharedComplete: boolean;
  readonly completeCourts: number;
  readonly courts: readonly SetupCourtCompletion[];
  readonly complete: boolean;
};

export type ProductionSetupRunResult =
  | { readonly kind: 'complete'; readonly inventory: ProductionSetupInventory }
  | { readonly kind: 'partial'; readonly inventory: ProductionSetupInventory }
  | {
      readonly kind: Exclude<SetupProgressKind, 'pending' | 'accepted'>;
      readonly unit: SetupUnit;
      readonly inventory: ProductionSetupInventory;
    };

export type ProductionSetupWorkspaceState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error'; readonly error: 'malformed' | 'transport' }
  | {
      readonly kind: 'ready';
      readonly inventory: ProductionSetupInventory;
      readonly draft: ProductionSetupDraft;
      readonly progress: SetupOperationProgress | null;
      readonly dirty: boolean;
    };
