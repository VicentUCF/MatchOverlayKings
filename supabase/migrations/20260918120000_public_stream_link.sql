-- The public home links each live court to its broadcast; the emission runtime owns the link.
alter table public.score_states
  add column if not exists youtube_watch_url text;

alter table public.score_states
  drop constraint if exists score_states_youtube_watch_url_check;

alter table public.score_states
  add constraint score_states_youtube_watch_url_check check (
    youtube_watch_url is null
    or youtube_watch_url ~ '^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{6,64}$'
  );

-- Publishing is a broadcast fact, not a scoring command: it never touches the match state or its version.
create or replace function public.publish_court_stream(p_court_slug text, p_watch_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.score_states%rowtype;
begin
  select * into v_row from public.score_states where court_slug = p_court_slug for update;
  if not found then
    raise exception 'No existe el marcador de esta pista.';
  end if;
  perform public.kpl_require_club_member(v_row.club_id);
  update public.score_states
    set youtube_watch_url = nullif(btrim(coalesce(p_watch_url, '')), '')
    where court_id = v_row.court_id;
end;
$$;

revoke all on function public.publish_court_stream(text, text) from public, anon;
grant execute on function public.publish_court_stream(text, text) to authenticated;
