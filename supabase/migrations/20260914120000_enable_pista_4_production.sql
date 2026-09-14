update public.courts
set production_enabled = true
where club_id = '00000000-0000-4000-8000-000000000001'
  and slug = 'pista-4'
  and production_enabled is distinct from true;
