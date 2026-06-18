# BakeryOps AI Prototype

Private, manual-entry operations dashboard for a bakery. This version uses no external database and no POS integration.

## Run Locally

PowerShell:

```powershell
$env:BAKERYOPS_USER="owner"
$env:BAKERYOPS_PASSWORD="change-this-password"
$env:DATA_DIR="./data"
node server.js
```

Open `http://127.0.0.1:4173`.

## Railway Configuration

The existing Railway service should use:

```text
npm start
```

Required variables:

```text
BAKERYOPS_USER=owner
BAKERYOPS_PASSWORD=<strong dashboard password>
HOST=0.0.0.0
DATA_DIR=/data
```

Railway supplies `PORT` automatically. Attach a Railway volume mounted at `/data` so records survive deploys and restarts.

## Persistent Files

The server creates these files when the first matching record is saved:

```text
DATA_DIR/expenses.json
DATA_DIR/sales.json
DATA_DIR/inventory.json
DATA_DIR/recipes.json
```

Each file contains a JSON array. Writes use a temporary file and rename step to reduce the risk of partial JSON files.

## Features

- Blank dashboard until real records are entered
- Manual expense, sale, inventory, and recipe forms
- Financial totals calculated only from stored expenses and sales
- Seven-day sales chart calculated from stored sales
- Delete controls for all four record types
- CSV export for expenses and sales
- Basic Auth protection using Railway environment variables

## API

```text
GET    /api/dashboard
POST   /api/expenses
DELETE /api/expenses/:id
POST   /api/sales
DELETE /api/sales/:id
POST   /api/inventory
DELETE /api/inventory/:id
POST   /api/recipes
DELETE /api/recipes/:id
GET    /api/export/expenses.csv
GET    /api/export/sales.csv
GET    /api/health
```
