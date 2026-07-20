-- BakeryOps Trend Finder. Safe to re-run; existing rows are never deleted or replaced.
create extension if not exists pgcrypto;

create table if not exists public.food_trends (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  category text not null default 'other'
    check (category in ('pastries','cakes','cookies','drinks','seasonal','packaging','other')),
  source_platform text not null default 'Manual curation' check (char_length(source_platform) <= 80),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  hashtags jsonb not null default '[]'::jsonb check (jsonb_typeof(hashtags) = 'array'),
  engagement_score smallint not null default 0 check (engagement_score between 0 and 100),
  relevance_score smallint not null default 0 check (relevance_score between 0 and 100),
  opportunity_score smallint not null default 0 check (opportunity_score between 0 and 100),
  trend_status text not null default 'active'
    check (trend_status in ('active','watching','testing','adopted','archived')),
  suggested_product text not null default '' check (char_length(suggested_product) <= 500),
  suggested_action text not null default '' check (char_length(suggested_action) <= 1000),
  analysis_reasoning text not null default '' check (char_length(analysis_reasoning) <= 1000),
  data_origin text not null default 'manual' check (data_origin in ('manual','demo','provider')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_seen_at >= first_seen_at)
);

create index if not exists food_trends_category_idx on public.food_trends(category);
create index if not exists food_trends_status_idx on public.food_trends(trend_status);
create index if not exists food_trends_opportunity_idx on public.food_trends(opportunity_score desc);
create index if not exists food_trends_last_seen_idx on public.food_trends(last_seen_at desc);

alter table public.food_trends enable row level security;

-- No public policy is created. BakeryOps accesses this table only through its
-- authenticated server using the existing Supabase service-role convention.
