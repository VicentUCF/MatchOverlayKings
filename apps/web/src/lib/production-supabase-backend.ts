import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductionBackend, ProductionTable } from './production-overview-adapter.js';

const COLUMNS = {
  production_principals: 'id,club_id,auth_user_id,kind,display_name,active,version,created_at,updated_at',
  production_principal_roles: 'principal_id,club_id,role,created_at',
  courts: 'id,club_id,slug,name,display_order,production_enabled',
  production_assignments: 'id,club_id,event_id,principal_id,role,active,version,created_at,updated_at',
  production_events: 'id,event_day_id,club_id,court_id,title,scheduled_start_at,scheduled_end_at,status,version,created_at,updated_at',
  production_outputs: 'id,club_id,event_id,court_id,name,kind,transport,enabled,version,created_at,updated_at',
  production_desired_states: 'output_id,club_id,event_id,version,state,updated_by_principal_id,command_id,updated_at',
  production_observed_states: 'output_id,agent_principal_id,club_id,event_id,sequence,health,state,reported_at',
  production_operations: 'id,club_id,event_id,court_id,output_id,command_id,kind,payload,before_state,after_state,requested_by_principal_id,created_at',
  production_operation_claims: 'operation_id,agent_principal_id,club_id,status,claimed_at,lease_expires_at,result,completed_at',
  score_states: 'club_id,court_slug,title,home_team_id,away_team_id,status,version,updated_at',
} as const satisfies Record<ProductionTable, string>;

export function createSupabaseProductionBackend(client: SupabaseClient): ProductionBackend {
  return Object.freeze({
    currentUser: () => client.auth.getUser(),
    select: async (table, filter) => {
      if (table === 'production_operation_claims') {
        return client
          .from('production_operation_claims')
          .select(COLUMNS.production_operation_claims)
          .eq(filter.column, filter.value);
      }
      return client
        .from(table)
        .select(COLUMNS[table])
        .eq(filter.column, filter.value);
    },
    rpc: async (name, args) => client.rpc(name, args),
    subscribe: (table, clubId, onChange) => {
      const channel = client.channel(`production-overview:${table}:${clubId}`).on('postgres_changes', {
        event: '*',
        schema: 'public',
        table,
        filter: `club_id=eq.${clubId}`,
      }, onChange).subscribe();
      return Object.freeze({ remove: () => client.removeChannel(channel) });
    },
  });
}
