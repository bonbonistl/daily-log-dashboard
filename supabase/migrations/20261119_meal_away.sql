-- House → Meals: days the family is away (traveling), so there's nothing to plan.
-- One row per away day; deleting the row clears it. Family-shared like meal_plan.

create table public.meal_away (
  id bigint generated always as identity primary key,
  family_id uuid not null default public.default_family_id() references public.families(id) on delete cascade,
  away_date date not null,
  note text,
  created_by text default public.current_email(),
  created_at timestamptz not null default now(),
  unique (family_id, away_date)
);

alter table public.meal_away enable row level security;

create policy "Family read access" on public.meal_away for select to authenticated using (family_id in (select public.my_family_ids()));
create policy "Family insert access" on public.meal_away for insert to authenticated with check (family_id in (select public.my_family_ids()));
create policy "Family update access" on public.meal_away for update to authenticated using (family_id in (select public.my_family_ids())) with check (family_id in (select public.my_family_ids()));
create policy "Family delete access" on public.meal_away for delete to authenticated using (family_id in (select public.my_family_ids()));
revoke all on public.meal_away from anon;
grant select, insert, update, delete on public.meal_away to authenticated;
