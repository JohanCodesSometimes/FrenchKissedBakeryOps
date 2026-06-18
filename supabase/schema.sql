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
  tax numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  sold_at timestamptz,
  source text not null default 'manual',
  square_payment_id text unique,
  square_order_id text,
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

create index if not exists expenses_date_idx on public.expenses(date);
create index if not exists sales_date_idx on public.sales(date);
create index if not exists sales_source_idx on public.sales(source);
create index if not exists inventory_name_idx on public.inventory_items(lower(ingredient_name));
create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients(recipe_id);
create index if not exists supplier_prices_ingredient_idx on public.supplier_prices(lower(ingredient_name), recorded_at desc);
create index if not exists activity_log_timestamp_idx on public.activity_log(timestamp desc);
create index if not exists trend_reports_created_idx on public.trend_reports(created_at desc);

alter table public.expenses enable row level security;
alter table public.inventory_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.sales enable row level security;
alter table public.supplier_prices enable row level security;
alter table public.trend_reports enable row level security;
alter table public.activity_log enable row level security;
alter table public.settings enable row level security;

-- No public policies are created. BakeryOps uses the service-role key only on the server.
