-- Meals: a recipe can be just a name (e.g. "Costco Orange Chicken") with no link or pasted text.
-- Name-only recipes are unique per family by case-insensitive name, so picking or typing the
-- same name again always lands on the same recipe and its cooking history.
alter table public.recipes drop constraint recipes_check;
create unique index recipes_family_title_no_url on public.recipes (family_id, lower(trim(title))) where url_key is null;
