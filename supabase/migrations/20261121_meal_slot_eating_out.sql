-- House → Meals: each planned meal is lunch or dinner (several per day is fine), and a
-- plan row can be "eating out" instead of a recipe (recipe_id null, optional place).
-- Existing rows were all dinners.

alter table public.meal_plan
  add column meal_slot text not null default 'dinner' check (meal_slot in ('lunch', 'dinner')),
  add column eating_out boolean not null default false,
  add column eat_out_place text check (eat_out_place is null or length(eat_out_place) <= 200);

alter table public.meal_plan alter column recipe_id drop not null;

-- Either a recipe or eating out (the composite FK still applies whenever recipe_id is set).
alter table public.meal_plan
  add constraint meal_plan_recipe_or_eating_out
  check ((eating_out and recipe_id is null) or (not eating_out and recipe_id is not null));
