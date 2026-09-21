export const PRODUCTION_TABLES = [
  'production_principals',
  'production_principal_roles',
  'courts',
  'production_assignments',
  'production_events',
  'production_outputs',
  'production_desired_states',
  'production_observed_states',
  'production_operations',
  'production_operation_claims',
  'score_states',
] as const;

export type ProductionTable = (typeof PRODUCTION_TABLES)[number];
export type RealtimeProductionTable = ProductionTable;

export type ProductionBackend = {
  readonly currentUser: () => Promise<unknown>;
  readonly select: (
    table: ProductionTable,
    filter: { readonly column: string; readonly value: string },
  ) => Promise<unknown>;
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly subscribe: (
    table: RealtimeProductionTable,
    clubId: string,
    onChange: () => void,
  ) => { readonly remove: () => Promise<unknown> };
};
