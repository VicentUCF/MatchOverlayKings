import type {
  ClubId,
  DesiredLifecycle,
  DesiredOutputState,
  Operation,
  OperationClaim,
  Output,
  PrincipalId,
  ProductionAssignment,
  ProductionEvent,
  ObservedOutputState,
} from '@kpl/production-contracts';

export const PRODUCTION_COURT_SLUGS = ['pista-1', 'pista-2', 'pista-3', 'pista-4'] as const;

export type ProductionCourtSlug = (typeof PRODUCTION_COURT_SLUGS)[number];

export type ScoreSummary = {
  readonly title: string;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly status: 'pre_match' | 'live' | 'finished';
  readonly version: number;
  readonly updatedAt: string;
};

export type ProductionCourtAssignment = {
  readonly event: ProductionEvent;
  readonly output: Output;
  readonly desired: DesiredOutputState;
  readonly observed: ObservedOutputState | null;
  readonly latestOperation: Operation | null;
  readonly latestOperationClaim: OperationClaim | null;
  readonly viewerAssignment: ProductionAssignment | null;
  readonly score: ScoreSummary | null;
};

export type ProductionCourtSlot = {
  readonly slug: ProductionCourtSlug;
  readonly courtId: string;
  readonly name: string;
  readonly productionEnabled: boolean;
  readonly assignment: ProductionCourtAssignment | null;
};

export type ProductionCourtSlots = readonly [
  ProductionCourtSlot,
  ProductionCourtSlot,
  ProductionCourtSlot,
  ProductionCourtSlot,
];

export type ProductionOverviewSnapshot = {
  readonly clubId: ClubId;
  readonly principalId: PrincipalId;
  readonly courts: ProductionCourtSlots;
  readonly loadedAt: string;
};

export type ProductionMutationResult =
  | {
      readonly kind: 'accepted';
      readonly acknowledgement: 'reconciliation_requested';
      readonly desired: DesiredOutputState;
    }
  | { readonly kind: 'conflict'; readonly currentVersion: number }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'transport' };

export type ViewerProductionAccess = {
  readonly kind: 'viewer';
  readonly snapshot: ProductionOverviewSnapshot;
};

export type OperatorProductionAccess = {
  readonly kind: 'admin' | 'operator';
  readonly snapshot: ProductionOverviewSnapshot;
  readonly reconcile: (
    assignment: ProductionCourtAssignment,
    lifecycle: DesiredLifecycle,
  ) => Promise<ProductionMutationResult>;
};

export type ProductionOverviewAccess = ViewerProductionAccess | OperatorProductionAccess;

export type ProductionLoadResult =
  | { readonly kind: 'success'; readonly access: ProductionOverviewAccess }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'transport' };

export type ProductionOverviewAdapter = {
  readonly load: () => Promise<ProductionLoadResult>;
  readonly subscribe: (access: ProductionOverviewAccess, onChange: () => void) => () => void;
};
