-- Pin the search path of the 52 application functions reported by the advisor.
-- Their application references are schema-qualified; built-ins resolve in pg_catalog.
-- ALTER preserves function bodies, signatures, ownership and existing grants.
alter function public.kpl_empty_lineups() set search_path = '';
alter function public.kpl_default_config() set search_path = '';
alter function public.kpl_create_active_set() set search_path = '';
alter function public.kpl_create_game(boolean) set search_path = '';
alter function public.kpl_create_initial_state(text, text, text, text, jsonb, text, text, text, jsonb) set search_path = '';
alter function public.kpl_score_snapshot(jsonb) set search_path = '';
alter function public.kpl_opposite_side(text) set search_path = '';
alter function public.kpl_side_label(text) set search_path = '';
alter function public.kpl_active_set_index(jsonb) set search_path = '';
alter function public.kpl_completed_set_count(jsonb, text) set search_path = '';
alter function public.kpl_is_game_complete(jsonb, jsonb) set search_path = '';
alter function public.kpl_is_set_complete(jsonb, jsonb) set search_path = '';
alter function public.kpl_should_play_tie_break(jsonb, jsonb) set search_path = '';
alter function public.kpl_complete_set_state(jsonb, int, jsonb, text) set search_path = '';
alter function public.kpl_award_game_state(jsonb, text) set search_path = '';
alter function public.kpl_add_tie_break_point_state(jsonb, text) set search_path = '';
alter function public.kpl_add_point_state(jsonb, text) set search_path = '';
alter function public.kpl_apply_snapshot_state(jsonb, jsonb) set search_path = '';
alter function public.kpl_reset_state(jsonb) set search_path = '';
alter function public.kpl_update_meta_state(jsonb, jsonb) set search_path = '';
alter function public.kpl_manual_patch_state(jsonb, jsonb) set search_path = '';
alter function public.kpl_undo_state(jsonb) set search_path = '';
alter function public.kpl_set_status_state(jsonb, text) set search_path = '';
alter function public.kpl_default_overlay_settings() set search_path = '';
alter function public.kpl_normalize_overlay_settings(jsonb) set search_path = '';
alter function public.kpl_state_with_overlay_defaults(jsonb) set search_path = '';
alter function public.kpl_update_overlay_settings_state(jsonb, jsonb) set search_path = '';
alter function public.kpl_default_cards() set search_path = '';
alter function public.kpl_is_match_card_id(text) set search_path = '';
alter function public.kpl_state_with_card_defaults(jsonb) set search_path = '';
alter function public.kpl_use_card_state(jsonb, text, text, text, text) set search_path = '';
alter function public.kpl_is_data_scene_kind(text) set search_path = '';
alter function public.kpl_normalize_data_scene_target(jsonb) set search_path = '';
alter function public.kpl_trigger_data_scene_state(jsonb, text, jsonb, text) set search_path = '';
alter function public.kpl_default_sponsor_ads() set search_path = '';
alter function public.kpl_normalize_sponsor_ids(jsonb) set search_path = '';
alter function public.kpl_normalize_sponsor_ticker(jsonb) set search_path = '';
alter function public.kpl_normalize_sponsor_fullscreen(jsonb) set search_path = '';
alter function public.kpl_normalize_sponsor_ads(jsonb) set search_path = '';
alter function public.kpl_state_with_sponsor_ad_defaults(jsonb) set search_path = '';
alter function public.kpl_update_sponsor_ticker_state(jsonb, jsonb) set search_path = '';
alter function public.kpl_trigger_sponsor_fullscreen_state(jsonb, jsonb, int, text) set search_path = '';
alter function public.production_prevent_mutation() set search_path = '';
alter function public.production_validate_principal_role() set search_path = '';
alter function public.production_validate_assignment() set search_path = '';
alter function public.production_validate_device() set search_path = '';
alter function public.production_validate_output_court() set search_path = '';
alter function public.production_guard_event_identity() set search_path = '';
alter function public.production_guard_output_identity() set search_path = '';
alter function public.production_guard_event_lifecycle() set search_path = '';
alter function public.production_event_transition_allowed(text, text) set search_path = '';
alter function public.production_event_day_transition_allowed(text, text) set search_path = '';

-- These helpers are implementation details of SECURITY DEFINER RPCs, not API entrypoints.
-- In particular, kpl_store_state relies on its caller to authorize the mutation.
-- Revoking client execution does not prevent the owning RPCs from calling them.
revoke execute on function public.kpl_load_command_context(text, int, text) from public, anon, authenticated;
revoke execute on function public.kpl_require_club_member(uuid) from public, anon, authenticated;
revoke execute on function public.kpl_store_state(uuid, uuid, text, text, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.production_prepare_command(jsonb) from public, anon, authenticated;
revoke execute on function public.production_require_human_admin(uuid) from public, anon, authenticated;

-- Supabase also grants anon/authenticated execution through default privileges.
-- Future functions must explicitly opt in to client access (for the migration role).
-- Schema-level REVOKE cannot remove global defaults, including PostgreSQL's PUBLIC grant.
alter default privileges revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
