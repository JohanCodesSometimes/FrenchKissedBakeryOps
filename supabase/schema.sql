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
  approved_at timestamptz
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
  unit_price numeric(12,4) not null check (unit_price >= 0),
  total_price numeric(12,2) not null,
  category text not null check (category in ('Ingredients','Packaging','Equipment','Utilities','Other')),
  update_inventory boolean not null default false,
  is_discount boolean not null default false,
  is_fee boolean not null default false,
  is_deposit boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.inventory_items add column if not exists category text not null default 'Ingredients';

alter table public.receipt_items
  add column if not exists receipt_id uuid references public.receipts(id) on delete cascade,
  add column if not exists raw_line text not null default '',
  add column if not exists is_discount boolean not null default false,
  add column if not exists is_fee boolean not null default false,
  add column if not exists is_deposit boolean not null default false;

alter table public.receipt_items
  drop constraint if exists receipt_items_unit_check,
  drop constraint if exists receipt_items_total_price_check;

alter table public.receipt_items
  add constraint receipt_items_unit_check
  check (unit in ('lb','oz','g','kg','count','dozen','gallon','unknown'));

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
create index if not exists receipt_items_expense_idx on public.receipt_items(expense_id);
create index if not exists receipt_items_receipt_idx on public.receipt_items(receipt_id);
create index if not exists receipts_uploaded_idx on public.receipts(uploaded_at desc);

alter table public.expenses enable row level security;
alter table public.inventory_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.sales enable row level security;
alter table public.customers enable row level security;
alter table public.supplier_prices enable row level security;
alter table public.trend_reports enable row level security;
alter table public.activity_log enable row level security;
alter table public.settings enable row level security;
alter table public.square_connections enable row level security;
alter table public.receipt_items enable row level security;
alter table public.receipts enable row level security;

-- No public policies are created. BakeryOps uses the service-role key only on the server.
