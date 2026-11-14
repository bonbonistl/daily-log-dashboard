-- Follow-up to 20261114_meal_shop_status_cook_notes.sql, run once the shop_status page was live.
-- Catch anything the old page wrote in between, then drop the old boolean.
update public.meal_plan
   set shop_status = case has_ingredients when true then 'have' when false then 'need' end
 where shop_status is null and has_ingredients is not null;
alter table public.meal_plan drop column has_ingredients;
