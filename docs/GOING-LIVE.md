# Going live

One-time setup to run ThermoHub for real. Everything here is free tier.

## 1. Install tools (this PC)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and reopen the terminal afterwards.

## 2. Register the app with Microsoft (Entra ID)

In https://entra.microsoft.com, signed in as an admin of **your** Microsoft 365:

1. **Applications → App registrations → New registration**
   - Name: `ThermoHub`
   - Supported account types: **Accounts in any organizational directory (Multitenant)**
   - Redirect URI: platform **Single-page application (SPA)**, URI `http://localhost:8788/`
2. On the app's **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID**.
3. Later, add the real dashboard address (for example `https://thermohub.pages.dev/`) under
   **Authentication → Single-page application → Redirect URIs**.

Other businesses: their Microsoft 365 admin approves ThermoHub once, by signing in or by opening
`https://login.microsoftonline.com/<their-tenant-id>/adminconsent?client_id=<client-id>`.

## 3. Create the cloud backend (Cloudflare)

Create a free account at https://dash.cloudflare.com, then in `backend\`:

```powershell
npm install
npx wrangler login
npx wrangler d1 create thermohub        # copy database_id into wrangler.toml
npm run db:init
```

Edit `backend\wrangler.toml`: set `ENTRA_CLIENT_ID`, `PLATFORM_TENANT_ID` (your Directory ID),
`PLATFORM_ADMIN_EMAILS`, and `ALLOWED_ORIGINS` (dashboard address(es), no trailing slash). Then:

```powershell
npm run deploy                          # prints https://thermohub-api.<you>.workers.dev
```

## 4. Point the dashboard at it

In `js\config.js` set `DEMO_MODE: false`, `API_URL` (from step 3) and `ENTRA_CLIENT_ID`.

## 5. Host the dashboard (GitHub + Cloudflare Pages)

1. Create a **private** GitHub repo and push this folder.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
   Build command: *none*. Output directory: `/`.
3. Add the Pages address to the Entra redirect URIs (step 2.3) and to `ALLOWED_ORIGINS` (redeploy the API).

## 6. First sign-in and setup

1. Sign in with your platform admin account.
2. **Setup → Add a business** (name + their Microsoft 365 tenant ID).
3. **Users** → add that business's first Business Admin.
4. **Setup → Pair a hub** → copy the token for the hub install (next phase).
5. Add buildings. Thermostats appear under **New thermostats** once the hub reports them.

## Free-tier limits

Cloudflare Workers free: 100,000 requests/day. A hub checking in every 15 seconds uses ~5,800/day,
so roughly 12–15 businesses fit comfortably. Beyond that, Workers Paid is $5/month for 10 million.
