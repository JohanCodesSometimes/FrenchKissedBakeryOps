# BakeryOps AI

Private bakery operations dashboard using persistent JSON storage. This foundation intentionally has no Square, Supabase, OpenAI, receipt AI, or trend integrations.

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

## Persistent Storage

The server creates these files at startup:

```text
DATA_DIR/expenses.json
DATA_DIR/inventory.json
DATA_DIR/recipes.json
DATA_DIR/sales.json
DATA_DIR/settings.json
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

## Cost Conversions

Recipe costing converts compatible units:

- Mass: `lb`, `oz`, `g`, `kg`
- Count: `count`, `dozen`
- Volume: `gallon`

If an ingredient has no matching inventory item or uses an incompatible unit, its cost is marked unavailable and recipe totals remain incomplete.
