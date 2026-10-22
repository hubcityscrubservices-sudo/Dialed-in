-- Private visit counter: page loads and a few milestones (a calibration or challenge started, results
-- reached). No IP address or personal data: a random per-browser id, the referring site's host name, a
-- campaign tag from the link, and phone or computer. Browsers can only add rows through log_event;
-- nothing is readable with the public key.
create table if not exists public.site_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor uuid not null,
  kind text not null,
  ref text,
  utm text,
  device text
);
alter table public.site_events enable row level security;
create index if not exists site_events_created_at on public.site_events (created_at);

create or replace function public.log_event(p_visitor uuid, p_kind text, p_ref text default null, p_utm text default null, p_device text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind not in ('visit', 'calibrate', 'daily', 'practice', 'results') then return; end if;
  insert into public.site_events (visitor, kind, ref, utm, device)
  values (p_visitor, p_kind, left(lower(p_ref), 100), left(lower(p_utm), 60),
          case when p_device in ('phone', 'tablet', 'computer') then p_device end);
end;
$$;

revoke all on function public.log_event(uuid, text, text, text, text) from public;
grant execute on function public.log_event(uuid, text, text, text, text) to anon, authenticated;
