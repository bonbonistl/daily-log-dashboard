-- A prayer request can be for several people. prayer_request_people is the link table;
-- prayer_requests.person_id stays only as the "first person" for older code and is now optional.
create table if not exists public.prayer_request_people (
  request_id bigint not null references public.prayer_requests(id) on delete cascade,
  person_id  bigint not null references public.people(id) on delete cascade,
  owner_email text not null default coalesce(public.current_email(), 'jthorp@gmail.com'),
  primary key (request_id, person_id)
);
create index if not exists prayer_request_people_person_idx on public.prayer_request_people (person_id);
create index if not exists prayer_request_people_owner_idx on public.prayer_request_people (owner_email);

alter table public.prayer_request_people enable row level security;
create policy "Owner read access"   on public.prayer_request_people for select using (owner_email = (select public.current_email()));
create policy "Owner insert access" on public.prayer_request_people for insert with check (owner_email = (select public.current_email()));
create policy "Owner update access" on public.prayer_request_people for update using (owner_email = (select public.current_email())) with check (owner_email = (select public.current_email()));
create policy "Owner delete access" on public.prayer_request_people for delete using (owner_email = (select public.current_email()));

insert into public.prayer_request_people (request_id, person_id, owner_email)
select id, person_id, owner_email from public.prayer_requests where person_id is not null
on conflict do nothing;

-- Deleting one person no longer deletes a request shared with others.
alter table public.prayer_requests alter column person_id drop not null;
alter table public.prayer_requests drop constraint prayer_requests_person_id_fkey;
alter table public.prayer_requests add constraint prayer_requests_person_id_fkey
  foreign key (person_id) references public.people(id) on delete set null;

-- ...but once a request has nobody left on it, it goes too (same as before for single-person requests).
create or replace function public.prayer_request_people_cleanup() returns trigger
language plpgsql set search_path = public as $$
begin
  delete from public.prayer_requests r
  where r.id = old.request_id
    and not exists (select 1 from public.prayer_request_people l where l.request_id = old.request_id);
  return null;
end $$;
drop trigger if exists prayer_request_people_cleanup on public.prayer_request_people;
create trigger prayer_request_people_cleanup after delete on public.prayer_request_people
  for each row execute function public.prayer_request_people_cleanup();
