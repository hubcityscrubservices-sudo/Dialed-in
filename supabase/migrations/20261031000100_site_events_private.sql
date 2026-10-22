-- The visit counter is write-only for browsers (through log_event); no direct table access at all.
revoke all on table public.site_events from anon, authenticated;
