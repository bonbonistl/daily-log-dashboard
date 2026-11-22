-- Every person in a family lives in family_members now, not just people who sign in.
--   kind = 'adult': has a Google email, signs in (invite flow unchanged).
--   kind = 'kid':   just a name, no email, never signs in (for now). Their email is null,
--                   so current_email() never matches them and they can't grant access.
-- Any active family member can add/rename/remove kids in their own family; adults are
-- still admin-only.
--
-- meal_ratings: 0–4 stars per person per cook (a meal_plan row with cooked_at set).

alter table public.family_members
  add column id uuid not null default gen_random_uuid(),
  add column kind text not null default 'adult' check (kind in ('adult','kid'));

alter table public.family_members drop constraint family_members_pkey;
alter table public.family_members alter column email drop not null;
alter table public.family_members
  add primary key (id),
  add constraint family_members_family_email unique (family_id, email),
  add constraint family_members_family_id_id unique (family_id, id),
  add constraint family_members_kind_email check ((kind = 'adult') = (email is not null)),
  add constraint family_members_kid_name check (kind = 'adult' or length(trim(display_name)) > 0),
  add constraint family_members_kid_status check (kind = 'adult' or (status = 'active' and role = 'member'));

create policy family_members_kid_insert on public.family_members for insert to authenticated
  with check (kind = 'kid' and family_id in (select public.my_family_ids()));
create policy family_members_kid_update on public.family_members for update to authenticated
  using (kind = 'kid' and family_id in (select public.my_family_ids()))
  with check (kind = 'kid' and family_id in (select public.my_family_ids()));
create policy family_members_kid_delete on public.family_members for delete to authenticated
  using (kind = 'kid' and family_id in (select public.my_family_ids()));

-- ---------- per-person ratings of each cook ----------
alter table public.meal_plan add constraint meal_plan_family_id_id unique (family_id, id);

create table public.meal_ratings (
  id bigint generated always as identity primary key,
  family_id uuid not null default public.default_family_id(),
  meal_plan_id bigint not null,
  member_id uuid not null,
  stars smallint not null check (stars between 0 and 4),
  rated_by text default public.current_email(),
  updated_at timestamptz not null default now(),
  unique (meal_plan_id, member_id),
  foreign key (family_id, meal_plan_id) references public.meal_plan (family_id, id) on delete cascade,
  foreign key (family_id, member_id) references public.family_members (family_id, id) on delete cascade
);
create index meal_ratings_member on public.meal_ratings (member_id);

alter table public.meal_ratings enable row level security;
create policy "Family read access" on public.meal_ratings for select to authenticated using (family_id in (select public.my_family_ids()));
create policy "Family insert access" on public.meal_ratings for insert to authenticated with check (family_id in (select public.my_family_ids()));
create policy "Family update access" on public.meal_ratings for update to authenticated using (family_id in (select public.my_family_ids())) with check (family_id in (select public.my_family_ids()));
create policy "Family delete access" on public.meal_ratings for delete to authenticated using (family_id in (select public.my_family_ids()));
revoke all on public.meal_ratings from anon;
grant select, insert, update, delete on public.meal_ratings to authenticated;
