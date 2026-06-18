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
SQUARE_APPLICATION_ID=<Square application ID>
SQUARE_APPLICATION_SECRET=<Square application secret>
SQUARE_OAUTH_REDIRECT_URL=https://<your-railway-domain>/api/square/oauth/callback
SQUARE_WEBHOOK_SIGNATURE_KEY=<Square webhook signature key>
SQUARE_WEBHOOK_URL=https://<your-railway-domain>/api/square/webhook
SQUARE_VERSION=2026-05-20
```

In the Square Developer Dashboard, add the exact OAuth redirect URL above. Create a webhook subscription using the exact webhook URL and subscribe to `payment.created` and `payment.updated`. The URL strings must match the Railway variables exactly because Square includes the notification URL when calculating its signature.

After Railway redeploys, open Settings and select **Connect Square**. Access and refresh tokens are encrypted before storage, remain server-only, and are never sent to the browser. Completed payments are deduplicated by Square payment ID and saved through the active Supabase or JSON storage backend.

## MarkItDown Document Preprocessing

MarkItDown is used only for PDFs, office documents, CSV, HTML, and text-based uploads. Grocery receipt photos never rely on MarkItDown: JPG, JPEG, PNG, and HEIC uploads go directly to OpenAI Vision. If text conversion fails or returns unusable text, the original document is sent as an OpenAI file input instead. Empty Markdown is never accepted as a successful parse.

Railway's Nixpacks configuration installs Node.js, Python, MarkItDown, FFmpeg, and ExifTool. No extra Railway build command is required. These optional variables are available:

```text
PYTHON_BIN=python3
MAX_DOCUMENT_UPLOAD_MB=20
```

The authenticated internal conversion endpoint is:

```text
POST /api/documents/convert
X-File-Name: invoice.pdf
Content-Type: application/octet-stream
<raw file bytes>
```

Uploads are written to a private temporary file, converted by `scripts/convert_to_markdown.py`, and deleted immediately. Markdown remains server-side and is not returned by the endpoint or stored in Supabase. The endpoint returns only conversion status, character count, and whether a fallback parser is required.

## Receipt Image Parsing

Set these server-only Railway variables:

```text
OPENAI_API_KEY=<project API key>
OPENAI_RECEIPT_MODEL=gpt-4.1-mini
MAX_DOCUMENT_UPLOAD_MB=20
```

The API key is used only by the Node server. Receipt images are held in private temporary files, converted to a compatible JPEG when HEIC is uploaded, sent for structured receipt extraction, and then deleted. Parsed drafts expire after 30 minutes and must be reviewed before anything is saved.

Open **Receipts** from the sidebar, then choose or drag in a JPG, JPEG, PNG, or PDF. The page shows byte-level upload progress followed by the extraction state. Its review area allows editing store/date/totals and every item name, quantity, unit, price, category, and inventory-update choice. Approval creates the expense and receipt line records, then updates selected inventory items and supplier price history. Receipt metadata and processing status remain visible in receipt history. Manual expense and inventory forms remain available.

For local development, install Python dependencies once:

```powershell
python -m pip install -r requirements.txt
```

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
- Backend-only MarkItDown preprocessing with secure temporary files and vision fallback signaling
- Grocery receipt vision parsing with editable review and approval before expense/inventory updates

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
