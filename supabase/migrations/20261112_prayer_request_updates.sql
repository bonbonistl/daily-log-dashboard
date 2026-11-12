-- Follow-up comments on a prayer request: [{ "at": ISO timestamp, "body": text }], oldest first.
-- Lives on the row so it inherits prayer_requests' owner_email RLS and loads with select *.
alter table public.prayer_requests add column if not exists updates jsonb not null default '[]'::jsonb;
