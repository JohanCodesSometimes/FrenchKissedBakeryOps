create extension if not exists pgcrypto;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  vendor text not null,
  category text not null check (category in ('Ingredients','Packaging','Equipment','Utilities','Other')),
  amount numeric(12,2) not null check (amount >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  ingredient_name text not null,
  category text not null default 'Ingredients' check (category in ('Ingredients','Packaging','Equipment','Utilities','Other')),
  quantity numeric(14,4) not null check (quantity >= 0),
  unit text not null check (unit in ('lb','oz','g','kg','count','dozen','gallon')),
  minimum_threshold numeric(14,4) not null check (minimum_threshold >= 0),
  supplier text not null default '',
  cost_per_unit numeric(14,4) not null default 0 check (cost_per_unit >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  recipe_name text not null,
  category text not null check (category in ('Cookies','Cakes','Cupcakes','Brownies','Pastries','Custom')),
  yield_quantity numeric(14,4) not null check (yield_quantity > 0),
  yield_unit text not null,
  selling_price numeric(12,2) not null default 0 check (selling_price >= 0),
  preparation_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  ingredient_name text not null,
  quantity numeric(14,4) not null check (quantity > 0),
  unit text not null check (unit in ('lb','oz','g','kg','count','dozen','gallon')),
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  product text not null,
  quantity_sold numeric(14,4) not null check (quantity_sold > 0),
  sale_amount numeric(12,2) not null check (sale_amount >= 0),
  gross_amount numeric(12,2) not null default 0,
  refunded_amount numeric(12,2) not null default 0,
  status text not null default 'completed',
  tax numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  sold_at timestamptz,
  source text not null default 'manual',
  square_payment_id text unique,
  square_order_id text,
  lifecycle_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  square_customer_id text unique,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  first_purchase_date date not null,
  latest_purchase_date date not null,
  total_spend numeric(12,2) not null default 0 check (total_spend >= 0),
  visit_count integer not null default 0 check (visit_count >= 0),
  favorite_product text not null default '',
  purchase_history jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.supplier_prices (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  ingredient_name text not null,
  supplier text not null default '',
  cost_per_unit numeric(14,4) not null check (cost_per_unit >= 0),
  unit text not null,
  source text not null default 'manual',
  recorded_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.trend_reports (
  id uuid primary key default gen_random_uuid(),
  trend_name text not null,
  why_trending text not null default '',
  product_ideas jsonb not null default '[]'::jsonb,
  difficulty text not null default '',
  price_range text not null default '',
  ingredients jsonb not null default '[]'::jsonb,
  product_fit jsonb not null default '[]'::jsonb,
  seed_keywords jsonb not null default '[]'::jsonb,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create table if not exists public.food_trends (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  category text not null default 'other' check (category in ('pastries','cakes','cookies','drinks','seasonal','packaging','other')),
  source_platform text not null default 'Manual curation' check (char_length(source_platform) <= 80),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  hashtags jsonb not null default '[]'::jsonb check (jsonb_typeof(hashtags) = 'array'),
  engagement_score smallint not null default 0 check (engagement_score between 0 and 100),
  relevance_score smallint not null default 0 check (relevance_score between 0 and 100),
  opportunity_score smallint not null default 0 check (opportunity_score between 0 and 100),
  trend_status text not null default 'active' check (trend_status in ('active','watching','testing','adopted','archived')),
  suggested_product text not null default '' check (char_length(suggested_product) <= 500),
  suggested_action text not null default '' check (char_length(suggested_action) <= 1000),
  analysis_reasoning text not null default '' check (char_length(analysis_reasoning) <= 1000),
  expected_ingredient_cost numeric(12,2) check (expected_ingredient_cost is null or expected_ingredient_cost >= 0),
  planned_quantity integer check (planned_quantity is null or planned_quantity >= 1),
  test_date date,
  target_selling_price numeric(12,2) check (target_selling_price is null or target_selling_price >= 0),
  test_notes text not null default '' check (char_length(test_notes) <= 2000),
  actual_quantity_produced integer check (actual_quantity_produced is null or actual_quantity_produced >= 0),
  actual_quantity_sold integer check (actual_quantity_sold is null or actual_quantity_sold >= 0),
  actual_revenue numeric(14,2) check (actual_revenue is null or actual_revenue >= 0),
  result_notes text not null default '' check (char_length(result_notes) <= 2000),
  test_outcome text check (test_outcome is null or test_outcome in ('repeat','adopt','revise','dismiss')),
  data_origin text not null default 'manual' check (data_origin in ('manual','demo','provider')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_seen_at >= first_seen_at),
  check (actual_quantity_produced is null or actual_quantity_sold is null or actual_quantity_sold <= actual_quantity_produced)
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  description text not null,
  timestamp timestamptz not null default now()
);

create table if not exists public.settings (
  id text primary key default 'owner',
  business_name text not null default '',
  owner_name text not null default '',
  currency text not null default 'USD',
  shopping_target_multiplier numeric(5,2) not null default 2,
  updated_at timestamptz not null default now()
);

create table if not exists public.square_connections (
  id text primary key default 'owner',
  merchant_id text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  oauth_state text,
  oauth_state_expires_at timestamptz,
  environment text not null default 'sandbox',
  updated_at timestamptz not null default now()
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid references public.expenses(id) on delete set null,
  file_name text not null,
  mime_type text not null default 'application/octet-stream',
  file_size bigint not null default 0,
  extraction_source text not null default '',
  store_name text not null default '',
  receipt_date date,
  subtotal numeric(12,2) not null default 0,
  tax numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  item_count integer not null default 0,
  status text not null check (status in ('processing','review','approved','failed')),
  error_code text not null default '',
  uploaded_at timestamptz not null default now(),
  approved_at timestamptz,
  content_hash text,
  duplicate_of_receipt_id uuid references public.receipts(id) on delete set null,
  review_payload jsonb not null default '{}'::jsonb
);

create table if not exists public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  receipt_id uuid references public.receipts(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  store_name text not null,
  receipt_date date not null,
  item_name text not null,
  raw_line text not null default '',
  quantity numeric(14,4) not null check (quantity > 0),
  unit text not null check (unit in ('lb','oz','g','kg','count','dozen','gallon','unknown')),
  received_quantity numeric(14,4),
  received_unit text,
  package_count numeric(14,4),
  package_size_quantity numeric(14,4),
  package_size_unit text,
  stock_quantity numeric(14,4),
  stock_unit text,
  unit_price numeric(12,4) not null check (unit_price >= 0),
  total_price numeric(12,2) not null,
  category text not null check (category in ('Ingredients','Packaging','Equipment','Utilities','Other')),
  update_inventory boolean not null default false,
  is_discount boolean not null default false,
  is_fee boolean not null default false,
  is_deposit boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.receipt_inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete restrict,
  receipt_item_id uuid not null references public.receipt_items(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  received_quantity numeric(14,4) not null check (received_quantity > 0),
  received_unit text not null,
  stock_quantity numeric(14,4) not null check (stock_quantity > 0),
  stock_unit text not null,
  quantity_before numeric(14,4) not null check (quantity_before >= 0),
  quantity_after numeric(14,4) not null check (quantity_after >= 0),
  applied_at timestamptz not null default now(),
  unique (receipt_item_id)
);

alter table public.inventory_items add column if not exists category text not null default 'Ingredients';

alter table public.receipt_items
  add column if not exists receipt_id uuid references public.receipts(id) on delete cascade,
  add column if not exists raw_line text not null default '',
  add column if not exists is_discount boolean not null default false,
  add column if not exists is_fee boolean not null default false,
  add column if not exists is_deposit boolean not null default false;

alter table public.receipts
  add column if not exists content_hash text,
  add column if not exists duplicate_of_receipt_id uuid references public.receipts(id) on delete set null,
  add column if not exists review_payload jsonb not null default '{}'::jsonb;

alter table public.receipt_items
  add column if not exists received_quantity numeric(14,4),
  add column if not exists received_unit text,
  add column if not exists package_count numeric(14,4),
  add column if not exists package_size_quantity numeric(14,4),
  add column if not exists package_size_unit text,
  add column if not exists stock_quantity numeric(14,4),
  add column if not exists stock_unit text;

update public.receipt_items
set received_quantity = quantity, received_unit = unit
where received_quantity is null or received_unit is null;

alter table public.receipt_items
  drop constraint if exists receipt_items_unit_check,
  drop constraint if exists receipt_items_total_price_check,
  drop constraint if exists receipt_items_quantity_check;

alter table public.receipt_items
  add constraint receipt_items_unit_check
  check (unit in ('lb','oz','g','kg','count','dozen','gallon','unknown')),
  add constraint receipt_items_quantity_check check (quantity > 0);

alter table public.square_connections add column if not exists scopes text;

alter table public.sales
  add column if not exists gross_amount numeric(12,2) not null default 0,
  add column if not exists refunded_amount numeric(12,2) not null default 0,
  add column if not exists status text not null default 'completed',
  add column if not exists lifecycle_updated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_lifecycle_status_check') then
    alter table public.sales
      add constraint sales_lifecycle_status_check
      check (status in ('completed','partially_refunded','refunded','canceled','failed','pending'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_gross_amount_check') then
    alter table public.sales
      add constraint sales_gross_amount_check check (gross_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_refunded_amount_check') then
    alter table public.sales
      add constraint sales_refunded_amount_check check (refunded_amount >= 0);
  end if;
end $$;

create index if not exists expenses_date_idx on public.expenses(date);
create index if not exists sales_date_idx on public.sales(date);
create index if not exists sales_source_idx on public.sales(source);
create index if not exists sales_created_at_idx on public.sales(created_at desc);
create index if not exists sales_updated_at_idx on public.sales(updated_at desc) where updated_at is not null;
create index if not exists sales_status_idx on public.sales(status);
create unique index if not exists sales_square_order_unique_idx
  on public.sales(square_order_id)
  where square_order_id is not null;
create index if not exists inventory_name_idx on public.inventory_items(lower(ingredient_name));
create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients(recipe_id);
create unique index if not exists customers_email_unique_idx
  on public.customers(lower(email))
  where email <> '';
create unique index if not exists customers_phone_unique_idx
  on public.customers(phone)
  where phone <> '';
create index if not exists customers_latest_purchase_idx on public.customers(latest_purchase_date desc);
create index if not exists customers_total_spend_idx on public.customers(total_spend desc);
create index if not exists supplier_prices_ingredient_idx on public.supplier_prices(lower(ingredient_name), recorded_at desc);
create index if not exists activity_log_timestamp_idx on public.activity_log(timestamp desc);
create index if not exists trend_reports_created_idx on public.trend_reports(created_at desc);
create index if not exists food_trends_category_idx on public.food_trends(category);
create index if not exists food_trends_status_idx on public.food_trends(trend_status);
create index if not exists food_trends_opportunity_idx on public.food_trends(opportunity_score desc);
create index if not exists food_trends_last_seen_idx on public.food_trends(last_seen_at desc);
create index if not exists receipt_items_expense_idx on public.receipt_items(expense_id);
create index if not exists receipt_items_receipt_idx on public.receipt_items(receipt_id);
create index if not exists receipts_uploaded_idx on public.receipts(uploaded_at desc);
create index if not exists receipts_content_hash_idx on public.receipts(content_hash);
create index if not exists receipt_adjustments_receipt_idx on public.receipt_inventory_adjustments(receipt_id);
create index if not exists receipt_adjustments_inventory_idx on public.receipt_inventory_adjustments(inventory_item_id, applied_at desc);

alter table public.expenses enable row level security;
alter table public.inventory_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.sales enable row level security;
alter table public.customers enable row level security;
alter table public.supplier_prices enable row level security;
alter table public.trend_reports enable row level security;
alter table public.food_trends enable row level security;
alter table public.activity_log enable row level security;
alter table public.settings enable row level security;
alter table public.square_connections enable row level security;
alter table public.receipt_items enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_inventory_adjustments enable row level security;

-- No public policies are created. BakeryOps uses the service-role key only on the server.

create or replace function public.apply_receipt_inventory(p_payload jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_receipt_id uuid := (p_payload->>'receipt_id')::uuid;
  v_status text;
  v_expense jsonb := p_payload->'expense';
  v_receipt jsonb := p_payload->'receipt';
  v_item jsonb;
  v_price jsonb;
  v_before numeric(14,4);
  v_after numeric(14,4);
  v_inventory_unit text;
  v_updated_count integer := 0;
begin
  select status into v_status from public.receipts where id = v_receipt_id for update;
  if not found then raise exception 'Receipt no longer exists'; end if;
  if v_status = 'approved' then
    return jsonb_build_object('alreadyApplied', true, 'inventoryUpdatedCount',
      (select count(*) from public.receipt_inventory_adjustments where receipt_id = v_receipt_id));
  end if;
  if v_status <> 'review' then raise exception 'Receipt is not ready for approval'; end if;

  insert into public.expenses (id, date, vendor, category, amount, notes, created_at, updated_at)
  values (
    (v_expense->>'id')::uuid, (v_expense->>'date')::date, v_expense->>'vendor', v_expense->>'category',
    (v_expense->>'amount')::numeric, coalesce(v_expense->>'notes', ''),
    (v_expense->>'created_at')::timestamptz, nullif(v_expense->>'updated_at', '')::timestamptz
  );

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    insert into public.receipt_items (
      id, expense_id, receipt_id, inventory_item_id, store_name, receipt_date, item_name, raw_line,
      quantity, unit, received_quantity, received_unit, stock_quantity, stock_unit,
      package_count, package_size_quantity, package_size_unit,
      unit_price, total_price, category, update_inventory, is_discount, is_fee, is_deposit, created_at
    ) values (
      (v_item->>'id')::uuid, (v_item->>'expense_id')::uuid, v_receipt_id,
      nullif(v_item->>'inventory_item_id', '')::uuid, v_item->>'store_name', (v_item->>'receipt_date')::date,
      v_item->>'item_name', coalesce(v_item->>'raw_line', ''), (v_item->>'quantity')::numeric, v_item->>'unit',
      (v_item->>'received_quantity')::numeric, v_item->>'received_unit',
      nullif(v_item->>'stock_quantity', '')::numeric, nullif(v_item->>'stock_unit', ''),
      nullif(v_item->>'package_count', '')::numeric, nullif(v_item->>'package_size_quantity', '')::numeric,
      nullif(v_item->>'package_size_unit', ''),
      (v_item->>'unit_price')::numeric, (v_item->>'total_price')::numeric, v_item->>'category',
      coalesce((v_item->>'update_inventory')::boolean, false), coalesce((v_item->>'is_discount')::boolean, false),
      coalesce((v_item->>'is_fee')::boolean, false), coalesce((v_item->>'is_deposit')::boolean, false),
      (v_item->>'created_at')::timestamptz
    );

    if coalesce((v_item->>'update_inventory')::boolean, false) then
      select quantity, unit into v_before, v_inventory_unit
      from public.inventory_items where id = (v_item->>'inventory_item_id')::uuid for update;
      if not found then raise exception 'Selected inventory item no longer exists'; end if;
      if v_inventory_unit <> v_item->>'stock_unit' then raise exception 'Inventory unit changed during receipt approval'; end if;
      v_after := v_before + (v_item->>'stock_quantity')::numeric;
      update public.inventory_items set
        quantity = v_after,
        supplier = v_item->>'store_name',
        cost_per_unit = coalesce(nullif(v_item->>'stock_unit_price', '')::numeric, cost_per_unit),
        updated_at = (v_item->>'created_at')::timestamptz
      where id = (v_item->>'inventory_item_id')::uuid;
      insert into public.receipt_inventory_adjustments (
        id, receipt_id, receipt_item_id, inventory_item_id, received_quantity, received_unit,
        stock_quantity, stock_unit, quantity_before, quantity_after, applied_at
      ) values (
        (v_item->>'adjustment_id')::uuid, v_receipt_id, (v_item->>'id')::uuid,
        (v_item->>'inventory_item_id')::uuid, (v_item->>'received_quantity')::numeric, v_item->>'received_unit',
        (v_item->>'stock_quantity')::numeric, v_item->>'stock_unit', v_before, v_after,
        (v_item->>'created_at')::timestamptz
      );
      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  for v_price in select value from jsonb_array_elements(p_payload->'price_history') loop
    insert into public.supplier_prices (
      id, inventory_item_id, ingredient_name, supplier, cost_per_unit, unit, source, recorded_at, metadata
    ) values (
      (v_price->>'id')::uuid, nullif(v_price->>'inventory_item_id', '')::uuid, v_price->>'ingredient_name',
      coalesce(v_price->>'supplier', ''), (v_price->>'cost_per_unit')::numeric, v_price->>'unit',
      'inventory_history', (v_price->>'recorded_at')::timestamptz, coalesce(v_price->'metadata', '{}'::jsonb)
    );
  end loop;

  update public.receipts set
    expense_id = (v_receipt->>'expense_id')::uuid,
    store_name = v_receipt->>'store_name', receipt_date = (v_receipt->>'receipt_date')::date,
    subtotal = (v_receipt->>'subtotal')::numeric, tax = (v_receipt->>'tax')::numeric,
    total = (v_receipt->>'total')::numeric, item_count = (v_receipt->>'item_count')::integer,
    status = 'approved', error_code = '', approved_at = (v_receipt->>'approved_at')::timestamptz,
    review_payload = coalesce(v_receipt->'review_payload', review_payload)
  where id = v_receipt_id;

  return jsonb_build_object('alreadyApplied', false, 'inventoryUpdatedCount', v_updated_count);
end;
$$;

revoke all on function public.apply_receipt_inventory(jsonb) from public, anon, authenticated;
grant execute on function public.apply_receipt_inventory(jsonb) to service_role;
