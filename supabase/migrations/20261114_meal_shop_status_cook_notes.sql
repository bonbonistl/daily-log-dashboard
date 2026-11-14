-- Meals: replace the Have/Need boolean with a three-way shopping status that adds "In cart",
-- and let each cooked entry carry its own note ("doubled the garlic", "kids loved it").
--
-- shop_status: null = not checked yet, 'need' = have to shop, 'in_cart' = shopped/ordered,
-- 'have' = have everything. missing_items stays the free-text list for need/in_cart.
-- recipes.notes (already there) holds the recipe-level notes shown in the side pane.

alter table public.meal_plan
  add column shop_status text check (shop_status in ('need', 'in_cart', 'have'));

update public.meal_plan
   set shop_status = case has_ingredients when true then 'have' when false then 'need' end
 where has_ingredients is not null;

alter table public.meal_plan
  add column cook_note text check (length(cook_note) <= 2000);

alter table public.recipes
  add constraint recipes_notes_len check (length(notes) <= 20000);

-- has_ingredients is dropped in 20261114_drop_meal_plan_has_ingredients.sql once the
-- new page is live, so the old page keeps working in between.
