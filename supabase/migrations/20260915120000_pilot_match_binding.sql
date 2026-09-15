-- The production configuration owns the identity; scoring commands cannot replace it.
create table public.pilot_match_bindings (
  court_id uuid primary key references public.courts(id) on delete cascade,
  home_team_id text not null references public.teams(id),
  away_team_id text not null references public.teams(id),
  title text not null,
  configuration jsonb not null,
  check (home_team_id <> away_team_id)
);
alter table public.pilot_match_bindings enable row level security;
revoke all on public.pilot_match_bindings from anon, authenticated;

create function public.kpl_guard_pilot_match()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_binding public.pilot_match_bindings%rowtype;
  v_court_name text;
begin
  select * into v_binding from public.pilot_match_bindings where court_id = new.court_id;
  if found then
    select name into v_court_name from public.courts where id = new.court_id;
    if new.home_team_id is distinct from v_binding.home_team_id
      or new.away_team_id is distinct from v_binding.away_team_id
      or new.title is distinct from v_binding.title
      or new.court_name is distinct from v_court_name
      or new.state->>'homeTeamId' is distinct from v_binding.home_team_id
      or new.state->>'awayTeamId' is distinct from v_binding.away_team_id
      or new.state->>'title' is distinct from v_binding.title
      or new.state->>'courtName' is distinct from v_court_name then
      raise exception 'El partido está fijado desde Administración. Cambia allí la configuración de la emisión.';
    end if;
    new.state := new.state || '{"productionConfigured":true}'::jsonb;
  end if;
  return new;
end;
$$;
create trigger guard_pilot_match before insert or update on public.score_states
for each row execute function public.kpl_guard_pilot_match();

create function public.configure_pilot_match(p_configuration jsonb, p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.score_states%rowtype;
  v_binding public.pilot_match_bindings%rowtype;
  v_home text;
  v_away text;
  v_title text;
  v_court_name text;
  v_actor uuid;
  v_next jsonb;
begin
  select * into v_row from public.score_states
    where court_slug = p_configuration->>'courtSlug' for update;
  if not found then raise exception 'No existe el marcador de esta pista.'; end if;
  v_actor := public.kpl_require_club_member(v_row.club_id);
  select * into v_binding from public.pilot_match_bindings where court_id = v_row.court_id;
  if not p_apply then
    -- updatedAt belongs to the local persistence envelope, not the shared configuration.
    if v_binding.court_id is null or v_binding.configuration is distinct from (p_configuration - 'updatedAt')
      or v_row.home_team_id <> v_binding.home_team_id or v_row.away_team_id <> v_binding.away_team_id then
      raise exception 'La emisión no coincide con el partido configurado. Guarda la configuración de la pista antes de preparar.';
    end if;
    return jsonb_build_object('homeTeamId', v_binding.home_team_id, 'awayTeamId', v_binding.away_team_id);
  end if;

  -- Resolve exact catalog names; ambiguous or unknown teams are rejected.
  select min(id) into v_home from public.teams
    where club_id = v_row.club_id and name = p_configuration->>'homeTeam' having count(*) = 1;
  select min(id) into v_away from public.teams
    where club_id = v_row.club_id and name = p_configuration->>'awayTeam' having count(*) = 1;
  if v_home is null or v_away is null or v_home = v_away then
    raise exception 'Selecciona dos equipos distintos del catálogo del club.';
  end if;
  v_title := (p_configuration->>'homeTeam') || ' vs ' || (p_configuration->>'awayTeam')
    || ' · Jornada ' || (p_configuration->>'matchdayNumber');
  select name into v_court_name from public.courts where id = v_row.court_id;
  if v_row.status = 'live' and (v_row.home_team_id <> v_home or v_row.away_team_id <> v_away or v_row.title <> v_title) then
    raise exception 'Finaliza el partido en juego antes de cambiar la configuración de la pista.';
  end if;
  insert into public.pilot_match_bindings (court_id, home_team_id, away_team_id, title, configuration)
    values (v_row.court_id, v_home, v_away, v_title, p_configuration - 'updatedAt')
    on conflict (court_id) do update set home_team_id = excluded.home_team_id,
      away_team_id = excluded.away_team_id, title = excluded.title, configuration = excluded.configuration;
  v_next := v_row.state || jsonb_build_object('homeTeamId', v_home, 'awayTeamId', v_away,
    'title', v_title, 'courtName', v_court_name, 'productionConfigured', true);
  if v_row.home_team_id <> v_home or v_row.away_team_id <> v_away then
    v_next := public.kpl_reset_state(v_next) || jsonb_build_object('dataScene', null);
    v_next := jsonb_set(v_next, '{cards}', public.kpl_default_cards());
    v_next := jsonb_set(v_next, '{lineups}', '{"home":{"player1":"","player2":""},"away":{"player1":"","player2":""}}'::jsonb);
  end if;
  perform public.kpl_store_state(v_row.court_id, v_actor, gen_random_uuid()::text, 'update_meta', null,
    'Configurar partido de la emisión', v_row.state, v_next,
    v_row.home_team_id <> v_home or v_row.away_team_id <> v_away);
  return jsonb_build_object('homeTeamId', v_home, 'awayTeamId', v_away);
end;
$$;
revoke all on function public.configure_pilot_match(jsonb, boolean) from public, anon;
grant execute on function public.configure_pilot_match(jsonb, boolean) to authenticated;
revoke all on function public.kpl_guard_pilot_match() from public, anon, authenticated;
