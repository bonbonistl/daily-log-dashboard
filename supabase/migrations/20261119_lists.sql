-- Lists tab: personal lists of anything (movies, restaurants, albums…) and their items.
-- Private per owner_email like the other personal tables (see 20261111_families.sql).

create table public.lists (
  id bigint generated always as identity primary key,
  owner_email text not null default coalesce(public.current_email(), 'jthorp@gmail.com'),
  name text not null check (length(trim(name)) > 0),
  emoji text,
  created_at timestamptz not null default now(),
  unique (owner_email, id)
);
create unique index lists_owner_name on public.lists (owner_email, lower(trim(name)));

create table public.list_items (
  id bigint generated always as identity primary key,
  owner_email text not null default coalesce(public.current_email(), 'jthorp@gmail.com'),
  list_id bigint not null,
  title text not null check (length(trim(title)) > 0),
  url text,
  notes text,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (owner_email, list_id) references public.lists (owner_email, id) on delete cascade
);
create index list_items_list on public.list_items (list_id);

alter table public.lists enable row level security;
alter table public.list_items enable row level security;

create policy "Owner read access" on public.lists for select to authenticated using (owner_email = (select public.current_email()));
create policy "Owner insert access" on public.lists for insert to authenticated with check (owner_email = (select public.current_email()));
create policy "Owner update access" on public.lists for update to authenticated using (owner_email = (select public.current_email())) with check (owner_email = (select public.current_email()));
create policy "Owner delete access" on public.lists for delete to authenticated using (owner_email = (select public.current_email()));

create policy "Owner read access" on public.list_items for select to authenticated using (owner_email = (select public.current_email()));
create policy "Owner insert access" on public.list_items for insert to authenticated with check (owner_email = (select public.current_email()));
create policy "Owner update access" on public.list_items for update to authenticated using (owner_email = (select public.current_email())) with check (owner_email = (select public.current_email()));
create policy "Owner delete access" on public.list_items for delete to authenticated using (owner_email = (select public.current_email()));

revoke all on public.lists, public.list_items from anon;
grant select, insert, update, delete on public.lists, public.list_items to authenticated;
