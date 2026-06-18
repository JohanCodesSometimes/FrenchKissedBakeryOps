# BakeryOps AI

Private bakery operations dashboard with optional Supabase storage and persistent JSON fallback. Square, OpenAI, receipt AI, and trend generation are not enabled yet.

## Run Locally

```powershell
$env:BAKERYOPS_USER="owner"
$env:BAKERYOPS_PASSWORD="change-this-password"
$env:DATA_DIR="./data"
npm start
```

Open `http://127.0.0.1:4173`.

## Railway

Start command:

```text
npm start
```

Variables:

```text
BAKERYOPS_USER=owner
BAKERYOPS_PASSWORD=<strong password>
HOST=0.0.0.0
DATA_DIR=/data
```

Railway provides `PORT`. The persistent volume must remain mounted at `/data`.

## Optional Supabase Storage

BakeryOps selects one storage backend at startup:

- If all Supabase variables are present, it uses Supabase.
- If they are absent, it uses JSON files in `DATA_DIR`.
- If only some variables are present, it logs a warning and uses JSON.

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=<project anon key>
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
```

Run `supabase/schema.sql` in the Supabase SQL Editor before adding these variables to Railway. The service-role key stays on the Node server and is never returned to the frontend.

Startup logs clearly show either Supabase mode or local JSON mode. Keep the Railway `/data` volume mounted until Supabase has been verified with production data.

## Persistent Storage

The server creates these files at startup:

```text
DATA_DIR/expenses.json
DATA_DIR/inventory.json
DATA_DIR/recipes.json
DATA_DIR/sales.json
DATA_DIR/settings.json
DATA_DIR/activity.json
DATA_DIR/price-history.json
DATA_DIR/supplier-prices.json
DATA_DIR/trend-reports.json
```

Writes use a temporary file and rename step. Existing records from the previous prototype schema are migrated in memory when loaded.

## Features

- Dashboard calculated entirely from stored records
- Expense add, edit, delete, monthly total, and CSV export
- Inventory add, edit, delete, supplier pricing, and low-stock alerts
- Recipe library with search, categories, dynamic ingredients, details, and CRUD
- Recipe cost calculations using compatible inventory units
- Sales add, edit, delete, revenue summaries, performance table, and CSV export
- Responsive desktop and mobile layout
- Basic Auth protection
- Full JSON backup export
- Month-selectable revenue, expense, profit, product, and category reports
- Low-stock shopping list with supplier and estimated cost
- Automatic ingredient price history when inventory pricing changes
- Recipe duplication
- CSV import for expenses, inventory, and sales
- Persistent activity log
- Owner settings for business name and shopping target quantity

## Cost Conversions

Recipe costing converts compatible units:

- Mass: `lb`, `oz`, `g`, `kg`
- Count: `count`, `dozen`
- Volume: `gallon`

If an ingredient has no matching inventory item or uses an incompatible unit, its cost is marked unavailable and recipe totals remain incomplete.

## CSV Import Columns

```text
Expenses: Date, Vendor, Category, Amount, Notes
Inventory: Ingredient Name, Quantity, Unit, Minimum Threshold, Supplier, Cost Per Unit
Sales: Date, Product, Quantity Sold, Sale Amount
```

Dates use `YYYY-MM-DD`. Import is limited to 1,000 rows per file. Invalid rows are rejected without inventing replacement values.

## Backup

`GET /api/backup.json` downloads settings and all stored operational data as one timestamped JSON file.
