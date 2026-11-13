-- Meals: per planned meal, note whether we have what we need to cook it.
-- has_ingredients: null = not checked yet, true = have everything, false = need to shop.
-- missing_items: free-text list of what to pick up (only meaningful when has_ingredients = false).
alter table public.meal_plan add column has_ingredients boolean;
alter table public.meal_plan add column missing_items text check (length(missing_items) <= 500);
