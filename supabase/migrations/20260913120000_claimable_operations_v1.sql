create or replace function public.production_list_claimable_operations_v1(p_limit integer)
returns table (
  id uuid,
  club_id uuid,
  event_id uuid,
  court_id uuid,
  output_id uuid,
  command_id text,
  kind text,
  payload jsonb,
  requested_by_principal_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_agent_id uuid := public.production_require_principal('agent');
  v_limit integer;
begin
  if p_limit is null or p_limit < 1 then raise exception 'INVALID_LIMIT'; end if;
  v_limit := least(100, p_limit);

  return query
  select
    operation.id,
    operation.club_id,
    operation.event_id,
    operation.court_id,
    operation.output_id,
    operation.command_id,
    operation.kind,
    operation.payload,
    operation.requested_by_principal_id,
    operation.created_at
  from public.production_operations operation
  join public.production_assignments assignment
    on assignment.event_id = operation.event_id
    and assignment.club_id = operation.club_id
    and assignment.principal_id = v_agent_id
    and assignment.role = 'agent'
    and assignment.active
  left join public.production_operation_claims claim
    on claim.operation_id = operation.id
  where claim.operation_id is null
    or (
      claim.status = 'claimed'
      and (
        claim.agent_principal_id = v_agent_id
        or claim.lease_expires_at <= pg_catalog.now()
      )
    )
  order by operation.created_at, operation.id
  limit v_limit;
end;
$$;

revoke all on function public.production_list_claimable_operations_v1(integer) from public, anon;
grant execute on function public.production_list_claimable_operations_v1(integer) to authenticated;

create or replace function public.production_get_assigned_output_snapshots_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_agent_id uuid := public.production_require_principal('agent');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'output', jsonb_build_object(
        'id', output.id,
        'club_id', output.club_id,
        'event_id', output.event_id,
        'court_id', output.court_id,
        'name', output.name,
        'kind', output.kind,
        'transport', output.transport,
        'enabled', output.enabled,
        'version', output.version,
        'created_at', output.created_at,
        'updated_at', output.updated_at
      ),
      'desired', jsonb_build_object(
        'output_id', desired.output_id,
        'club_id', desired.club_id,
        'event_id', desired.event_id,
        'version', desired.version,
        'state', desired.state,
        'updated_by_principal_id', desired.updated_by_principal_id,
        'command_id', desired.command_id,
        'updated_at', desired.updated_at
      ),
      'observed', case when observed.output_id is null then null else jsonb_build_object(
        'output_id', observed.output_id,
        'agent_principal_id', observed.agent_principal_id,
        'club_id', observed.club_id,
        'event_id', observed.event_id,
        'sequence', observed.sequence,
        'health', observed.health,
        'state', observed.state,
        'reported_at', observed.reported_at
      ) end
    ) order by output.court_id, output.id)
    from public.production_outputs output
    join public.production_desired_states desired
      on desired.output_id = output.id
      and desired.event_id = output.event_id
      and desired.club_id = output.club_id
    join public.production_assignments assignment
      on assignment.event_id = output.event_id
      and assignment.club_id = output.club_id
      and assignment.principal_id = v_agent_id
      and assignment.role = 'agent'
      and assignment.active
    left join public.production_observed_states observed
      on observed.output_id = output.id
      and observed.event_id = output.event_id
      and observed.club_id = output.club_id
      and observed.agent_principal_id = v_agent_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.production_get_assigned_output_snapshots_v1() from public, anon;
grant execute on function public.production_get_assigned_output_snapshots_v1() to authenticated;
