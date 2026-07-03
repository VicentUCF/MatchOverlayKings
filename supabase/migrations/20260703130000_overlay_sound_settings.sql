create or replace function public.kpl_default_overlay_settings()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'visible', true,
    'size', 'standard',
    'position', 'top-left',
    'dataScenesAuto', false,
    'soundEnabled', false,
    'soundVolume', 0.55
  );
$$;

create or replace function public.kpl_normalize_overlay_settings(p_settings jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_visible boolean := true;
  v_size text := 'standard';
  v_position text := 'top-left';
  v_data_scenes_auto boolean := false;
  v_sound_enabled boolean := false;
  v_sound_volume numeric := 0.55;
begin
  if jsonb_typeof(p_settings -> 'visible') = 'boolean' then
    v_visible := (p_settings ->> 'visible')::boolean;
  end if;

  if p_settings ->> 'size' in ('compact', 'standard', 'large') then
    v_size := p_settings ->> 'size';
  end if;

  if p_settings ->> 'position' in ('top-left', 'center', 'bottom-center') then
    v_position := p_settings ->> 'position';
  end if;

  if jsonb_typeof(p_settings -> 'dataScenesAuto') = 'boolean' then
    v_data_scenes_auto := (p_settings ->> 'dataScenesAuto')::boolean;
  end if;

  if jsonb_typeof(p_settings -> 'soundEnabled') = 'boolean' then
    v_sound_enabled := (p_settings ->> 'soundEnabled')::boolean;
  end if;

  if jsonb_typeof(p_settings -> 'soundVolume') = 'number' then
    v_sound_volume := least(1, greatest(0, (p_settings ->> 'soundVolume')::numeric));
  end if;

  return jsonb_build_object(
    'visible', v_visible,
    'size', v_size,
    'position', v_position,
    'dataScenesAuto', v_data_scenes_auto,
    'soundEnabled', v_sound_enabled,
    'soundVolume', v_sound_volume
  );
end;
$$;

update public.score_states
set state = jsonb_set(
  state,
  '{overlaySettings}',
  public.kpl_normalize_overlay_settings(state -> 'overlaySettings'),
  true
)
where
  state -> 'overlaySettings' -> 'soundEnabled' is null
  or state -> 'overlaySettings' -> 'soundVolume' is null;
