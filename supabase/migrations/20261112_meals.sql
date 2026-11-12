-- House → Meals: a family-shared recipe box plus a dated meal plan that doubles as the
-- "what we cooked when" history (a plan row with cooked_at set = cooked that day).
--
-- recipes.url_key is the normalized URL (see mealsNormalizeUrl in meals.js): host without
-- www./m., no protocol, no tracking params, no trailing slash. Unique per family, so the
-- same recipe shared with different ?utm=… / ?igsh=… attributes is always one recipe.

create table public.recipes (
  id bigint generated always as identity primary key,
  family_id uuid not null default public.default_family_id() references public.families(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  url text,
  url_key text,
  source_text text,           -- pasted recipe (e.g. an Instagram caption)
  notes text,
  created_by text default public.current_email(),
  created_at timestamptz not null default now(),
  unique (family_id, id),
  check (url is not null or source_text is not null)
);
create unique index recipes_family_url_key on public.recipes (family_id, url_key) where url_key is not null;

create table public.meal_plan (
  id bigint generated always as identity primary key,
  family_id uuid not null default public.default_family_id(),
  recipe_id bigint not null,
  plan_date date not null,
  cooked_at timestamptz,      -- null = planned, set = cooked
  cooked_by text,
  created_by text default public.current_email(),
  created_at timestamptz not null default now(),
  -- Composite FK keeps a plan row in the same family as its recipe.
  foreign key (family_id, recipe_id) references public.recipes (family_id, id) on delete cascade
);
create index meal_plan_family_date on public.meal_plan (family_id, plan_date);
create index meal_plan_recipe on public.meal_plan (recipe_id);

alter table public.recipes enable row level security;
alter table public.meal_plan enable row level security;

do $$
declare t text;
begin
  foreach t in array array['recipes','meal_plan'] loop
    execute format('create policy "Family read access" on public.%I for select to authenticated using (family_id in (select public.my_family_ids()))', t);
    execute format('create policy "Family insert access" on public.%I for insert to authenticated with check (family_id in (select public.my_family_ids()))', t);
    execute format('create policy "Family update access" on public.%I for update to authenticated using (family_id in (select public.my_family_ids())) with check (family_id in (select public.my_family_ids()))', t);
    execute format('create policy "Family delete access" on public.%I for delete to authenticated using (family_id in (select public.my_family_ids()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
