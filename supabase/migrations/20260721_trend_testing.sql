-- Add owner-entered Trend Finder test plans and results without changing existing records.
alter table public.food_trends
  add column if not exists expected_ingredient_cost numeric(12,2),
  add column if not exists planned_quantity integer,
  add column if not exists test_date date,
  add column if not exists target_selling_price numeric(12,2),
  add column if not exists test_notes text not null default '',
  add column if not exists actual_quantity_produced integer,
  add column if not exists actual_quantity_sold integer,
  add column if not exists actual_revenue numeric(14,2),
  add column if not exists result_notes text not null default '',
  add column if not exists test_outcome text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'food_trends_test_values_check') then
    alter table public.food_trends
      add constraint food_trends_test_values_check check (
        (expected_ingredient_cost is null or expected_ingredient_cost >= 0) and
        (planned_quantity is null or planned_quantity >= 1) and
        (target_selling_price is null or target_selling_price >= 0) and
        (actual_quantity_produced is null or actual_quantity_produced >= 0) and
        (actual_quantity_sold is null or actual_quantity_sold >= 0) and
        (actual_revenue is null or actual_revenue >= 0) and
        (actual_quantity_produced is null or actual_quantity_sold is null or actual_quantity_sold <= actual_quantity_produced) and
        (test_outcome is null or test_outcome in ('repeat','adopt','revise','dismiss')) and
        char_length(test_notes) <= 2000 and
        char_length(result_notes) <= 2000
      );
  end if;
end $$;
