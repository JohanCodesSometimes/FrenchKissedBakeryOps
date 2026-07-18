# BakeryOps AI

Private bakery operations dashboard with optional Supabase storage, persistent JSON fallback, and Square POS sales sync.

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
OPENAI_API_KEY=<OpenAI API key>
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

Re-run the schema after updating BakeryOps to create the private `square_connections`, `receipts`, and `receipt_items` tables. Row-level security is enabled and no public policy is created for them.

## Square Setup

Add these variables in Railway:

```text
SQUARE_ENVIRONMENT=sandbox
SQUARE_CLIENT_ID=<Square application/client ID>
SQUARE_APPLICATION_SECRET=<Square application secret>
SQUARE_REDIRECT_URI=https://<your-railway-domain>/api/square/oauth/callback
SQUARE_WEBHOOK_SIGNATURE_KEY=<Square webhook signature key>
SQUARE_WEBHOOK_URL=https://<your-railway-domain>/api/square/webhook
SQUARE_VERSION=2026-05-20
```

In the Square Developer Dashboard, add the exact OAuth redirect URL above. Create a webhook subscription using the exact webhook URL and subscribe to `payment.created`, `payment.updated`, `order.created`, and `order.updated`. The URL strings must match the Railway variables exactly because Square includes the notification URL when calculating its signature.

After Railway redeploys, open Settings and select **Connect Square**. The dashboard asks `/api/square/oauth-url` for a new authorization URL at click time and never stores the OAuth URL in browser storage. Access and refresh tokens are encrypted before storage, remain server-only, and are never sent to the browser. Completed payments and orders are deduplicated by Square payment ID or order ID and saved through the active Supabase or JSON storage backend. Settings also provides **Sync Recent Square Sales**, which scans up to the previous 30 days and follows Square pagination.

## Receipt AI

Receipt images are parsed on the Node backend with OpenAI Vision. Add this server-only Railway variable:

```text
OPENAI_API_KEY=<OpenAI API key>
```

The browser accepts JPG, JPEG, and PNG files up to 15 MB. Images are held in memory for parsing and the API key is never sent to the frontend. The owner reviews and edits every extracted line before approval creates an expense, receipt items, inventory changes, supplier price history, and an activity entry.

Receipt AI does not use Python, MarkItDown, a virtual environment, or custom Nixpacks configuration. Manual Expense and Inventory entry remains available when receipt parsing is not configured or fails.

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
DATA_DIR/square-connection.json
DATA_DIR/receipt-items.json
DATA_DIR/receipts.json
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
- Square OAuth connection, signed webhooks, completed-payment sales sync, and duplicate prevention
- Lightweight 12-second sales polling that updates dashboard KPIs, charts, tables, inventory, customer intelligence, and purchasing forecasts without reloading
- Live, Reconnecting, and Offline status with manual retry, visibility recovery, overlap prevention, and capped exponential backoff
- OpenAI Vision receipt extraction with editable review and approval

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

## Next Phase: Production Planning

The next recommended feature is demand-driven production planning. It should combine recent product sales,
recipe yields, and current inventory to suggest daily bake quantities and flag ingredient constraints. The
existing sales polling, recipe costing, and inventory modules provide the required inputs; implementation
should remain advisory first, with no automatic inventory or purchasing mutations.