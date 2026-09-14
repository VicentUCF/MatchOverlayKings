import type { JsonValue } from '@kpl/production-contracts';

export type ControlPlaneTableName =
  | 'production_desired_states'
  | 'production_observed_states'
  | 'production_outputs';

export type ControlPlaneRpcName =
  | 'production_claim_operation_v1'
  | 'production_complete_operation_v1'
  | 'production_get_assigned_output_snapshots_v1'
  | 'production_get_assigned_secret_refs_v1'
  | 'production_list_claimable_operations_v1'
  | 'production_report_observed_state_v1';

export type ControlPlaneRequest =
  | {
      readonly kind: 'select';
      readonly name: ControlPlaneTableName;
      readonly columns: string;
    }
  | {
      readonly kind: 'rpc';
      readonly name: ControlPlaneRpcName;
      readonly args: Readonly<Record<string, JsonValue>>;
    };

export type ControlPlaneResponse =
  | { readonly data: unknown; readonly error: null }
  | {
      readonly data: null;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ControlPlaneRequestExecutor = (
  request: ControlPlaneRequest,
  signal: AbortSignal,
) => Promise<ControlPlaneResponse>;
