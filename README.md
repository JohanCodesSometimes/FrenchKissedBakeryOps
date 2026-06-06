# BakeryOps AI Prototype

Private frontend and Square POS integration prototype for BakeryOps AI.

## Run Locally

```powershell
$env:BAKERYOPS_USER="owner"
$env:BAKERYOPS_PASSWORD="change-this-password"
npm start
```

Open:

```text
http://127.0.0.1:4173
```

## Deploy on Railway

1. Create a new Railway project.
2. Deploy this folder from GitHub or the Railway CLI.
3. Add the environment variables from `.env.example`.
4. Railway should use:

```text
npm start
```

The app binds to `HOST=0.0.0.0` and Railway provides `PORT`.
For this private prototype, attach a Railway volume and mount it at `/data` so Square OAuth tokens and sales state survive restarts.

## Required Railway Variables

```text
BAKERYOPS_USER=owner
BAKERYOPS_PASSWORD=<strong dashboard password>
HOST=0.0.0.0
DATA_DIR=/data

SQUARE_ENVIRONMENT=sandbox
SQUARE_APPLICATION_ID=<Square app id>
SQUARE_APPLICATION_SECRET=<Square app secret>
SQUARE_OAUTH_REDIRECT_URL=https://your-railway-domain.up.railway.app/api/square/oauth/callback
SQUARE_WEBHOOK_SIGNATURE_KEY=<Square webhook signature key>
SQUARE_WEBHOOK_URL=https://your-railway-domain.up.railway.app/api/square/webhook
SQUARE_VERSION=2026-05-20
```

Use `SQUARE_ENVIRONMENT=production` when connecting the bakery owner's real Square account.

## Square Setup

In the Square Developer Dashboard:

1. Create or open the BakeryOps AI application.
2. Add this OAuth redirect URL:

```text
https://your-railway-domain.up.railway.app/api/square/oauth/callback
```

3. Create a webhook subscription with this notification URL:

```text
https://your-railway-domain.up.railway.app/api/square/webhook
```

4. Subscribe to payment events, especially:

```text
payment.updated
```

5. Copy the webhook signature key into Railway as `SQUARE_WEBHOOK_SIGNATURE_KEY`.

## Runtime Flow

1. The bakery owner clicks **Connect Square**.
2. Square asks the owner to authorize read access for payments, orders, and merchant profile.
3. Square sends the app a webhook when a POS payment changes.
4. BakeryOps verifies the Square webhook signature.
5. BakeryOps retrieves the payment and ignores anything not `COMPLETED`.
6. BakeryOps retrieves the related order.
7. Products sold, quantity, total, tax, discounts, and timestamp are saved.
8. Recipe ingredients are deducted from inventory.
9. The Profit Command Center refreshes from `/api/dashboard`.

## Current Prototype Notes

Sales and Square OAuth tokens are stored in `DATA_DIR/bakeryops.json`. That is acceptable for a private prototype with a Railway volume, but a production build should move this data to PostgreSQL/Supabase before relying on it for real operations.
