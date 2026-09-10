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

alter table public.receipt_items drop constraint if exists receipt_items_quantity_check;
alter table public.receipt_items add constraint receipt_items_quantity_check check (quantity > 0);

update public.receipt_items
set received_quantity = quantity,
    received_unit = unit
where received_quantity is null or received_unit is null;

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

create index if not exists receipts_content_hash_idx on public.receipts(content_hash);
create index if not exists receipt_adjustments_receipt_idx on public.receipt_inventory_adjustments(receipt_id);
create index if not exists receipt_adjustments_inventory_idx on public.receipt_inventory_adjustments(inventory_item_id, applied_at desc);

alter table public.receipt_inventory_adjustments enable row level security;

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
