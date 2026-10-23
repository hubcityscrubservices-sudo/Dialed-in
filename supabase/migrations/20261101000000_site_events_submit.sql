-- The visit counter also counts posted challenge scores ('submit').
create or replace function public.log_event(p_visitor uuid, p_kind text, p_ref text default null, p_utm text default null, p_device text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind not in ('visit', 'calibrate', 'daily', 'practice', 'results', 'submit') then return; end if;
  insert into public.site_events (visitor, kind, ref, utm, device)
  values (p_visitor, p_kind, left(lower(p_ref), 100), left(lower(p_utm), 60),
          case when p_device in ('phone', 'tablet', 'computer') then p_device end);
end;
$$;
