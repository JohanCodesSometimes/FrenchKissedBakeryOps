# BakeryOps AI

Private bakery operations dashboard with Supabase production storage, local JSON development storage, and Square POS sales sync.

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
NODE_ENV=production npm start
```

Variables:

```text
BAKERYOPS_USER=owner
BAKERYOPS_PASSWORD=<strong password>
NODE_ENV=production
HOST=0.0.0.0
OPENAI_API_KEY=<OpenAI API key>
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=<project anon key>
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
```

Railway provides `PORT`. `package.json` requires Node 20 or newer, which Nixpacks honors. The Railway configuration exposes `/api/health` before database bootstrap completes, retries failed Supabase startup in the background, and does not require a persistent volume.

### Production Authentication

`BAKERYOPS_PASSWORD` is required whenever `NODE_ENV=production`. BakeryOps fails closed if it is missing: `/api/health` remains available for Railway, but the application, APIs, Square callback, and webhook processing return `503 AUTH_CONFIGURATION_REQUIRED`. `BAKERYOPS_USER` defaults to `owner`. Use a unique strong password stored only in Railway variables; credentials are never written to logs.

Local development remains usable without a password. Set `BAKERYOPS_PASSWORD` locally when you want to test the same HTTP Basic authentication used in production.

## Storage

BakeryOps uses storage according to the runtime environment:

- Production requires all three Supabase variables and never falls back to JSON.
- Local development uses Supabase when all three variables are present.
- Local development uses JSON files in `DATA_DIR` when Supabase is absent or incomplete.

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=<project anon key>
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
```

Run `supabase/schema.sql` in the Supabase SQL Editor before adding these variables to Railway. For an existing database, run `supabase/migrations/20260720_food_trends.sql` to add Trend Finder, followed by `supabase/migrations/20260721_trend_testing.sql` to add owner-entered test plans and results. These SQL files are idempotent and do not seed or replace data. The service-role key stays on the Node server and is never returned to the frontend.

If Supabase is unavailable, `/api/health` remains available while database-dependent routes return a structured `503 DATABASE_UNAVAILABLE` response with `Retry-After`. BakeryOps retries with bounded exponential backoff and reloads application state after recovery.

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

In the Square Developer Dashboard, add the exact OAuth redirect URL above. Create a webhook subscription using the exact webhook URL and subscribe to `payment.created`, `payment.updated`, `order.created`, `order.updated`, `refund.created`, and `refund.updated`. The URL strings must match the Railway variables exactly because Square includes the notification URL when calculating its signature.

After Railway redeploys, open Settings and select **Connect Square**. The dashboard asks `/api/square/oauth-url` for a new authorization URL at click time and never stores the OAuth URL in browser storage. Access and refresh tokens are encrypted before storage, remain server-only, and are never sent to the browser. Square payment, order, cancellation, and refund events reconcile onto one sale by Square payment or order ID. Fully refunded, canceled, failed, and pending records remain visible for audit but do not contribute revenue or purchasing demand; partial refunds contribute net revenue and proportional demand. Square lifecycle events do not directly mutate inventory quantities. Settings also provides **Sync Recent Square Sales**, which scans up to the previous 30 days and follows Square pagination.

`SQUARE_APPLICATION_ID` and `SQUARE_OAUTH_REDIRECT_URL` remain supported only as deprecated aliases for existing deployments. New and updated environments should use `SQUARE_CLIENT_ID` and `SQUARE_REDIRECT_URI`; when both are present, the standard names take precedence.

## Receipt AI

Receipt images are parsed on the Node backend with OpenAI Vision. Add this server-only Railway variable:

```text
OPENAI_API_KEY=<OpenAI API key>
```

The browser accepts JPG, JPEG, and PNG files up to 15 MB. Images are held in memory for parsing and the API key is never sent to the frontend. The owner reviews and edits every extracted line before approval creates an expense, receipt items, inventory changes, supplier price history, and an activity entry.

Receipt AI does not use Python, MarkItDown, a virtual environment, or custom Nixpacks configuration. Manual Expense and Inventory entry remains available when receipt parsing is not configured or fails.

Startup logs clearly show either Supabase mode or local JSON mode. Production operational data is stored in Supabase; local JSON storage is for development only.

## Local Development Storage

When Supabase is not configured outside production, the server creates these local development files at startup:

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
DATA_DIR/food-trends.json
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
- Trend Finder with manual curation, filtering, deterministic bakery scoring, recommendations, and owner-recorded test plans and results
- Contacts refresh lifecycle that runs only while Contacts is active and the browser tab is visible

## TikTok Food Trend Finder

Trend Finder helps the owner capture food ideas observed on TikTok or elsewhere, compare their bakery fit, and turn promising ideas into small, measurable product tests. It does **not** scrape TikTok, authenticate with TikTok, extract data from pasted links, or represent a live TikTok feed. Records are labeled as manually curated, demo samples, or configured-provider data, and source links are references only.

### Apply the Supabase migration

For an existing Supabase project, run `supabase/migrations/20260720_food_trends.sql` and then `supabase/migrations/20260721_trend_testing.sql` in the SQL Editor. Confirm `public.food_trends` exists, row-level security is enabled, and no public policy was created. New installations can run the complete `supabase/schema.sql`. If the base migration has not been applied, the trend API returns a safe `503` message while `/api/health` remains available.

### Load demo trends intentionally

The database starts empty. Run `npm run seed:trends` to add eight clearly labeled development samples. The script is idempotent by sample ID, refuses to run when `NODE_ENV=production`, and never runs during startup or deployment.

### Scoring

**Analyze** runs deterministic local logic and does not require OpenAI. Relevance and opportunity scores range from 0–100 and consider bakery/category keywords, visual presentation, production difficulty, current inventory matches, seasonal timing, premium/margin signals, and the manually entered engagement signal. Scores are decision support, not verified market demand.

Trend Finder adds no environment variables or paid-service dependency. Current limitations are manual discovery, owner-entered engagement signals, heuristic recommendations, and no configured external provider. A future approved provider can write normalized records with `data_origin=provider` through a server-only adapter.

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
