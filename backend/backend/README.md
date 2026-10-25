# FinSentinels — SIH 2026 PS-29

FinSentinels is an explainable graph-based financial fraud investigation platform for Smart India Hackathon Problem Statement 29: **AI-Based Financial Fraud Network Detection**.

The repository also includes a public product site and a customer preview workspace. Customer preview identities and linked sample transactions are stored separately in SQLite; the analyst graph continues to use the existing JSON ingestion pipeline. Both customer accounts and the transaction records shown to them are synthetic. This is an early evaluation build, not a production banking service.

## What the MVP actually does

The system turns transaction records into a typed NetworkX `MultiDiGraph` and analyzes relationships rather than scoring each transaction in isolation.

Supported graph entities:

- Accounts
- Devices
- Merchants
- Locations
- IP addresses

Supported detection signals:

- Circular fund routing / fraud rings
- Shared-device reuse
- Shared-IP reuse
- Cross-border transaction context
- Transaction velocity
- Network connectivity / centrality
- Mule-account flow behavior
- High-value transaction context

Every account investigation reports a linked-network risk score (0–100), a risk band, its account-level signal, the linked cohort and human-readable score components. Case lists and search recalculate from the same live graph so a case does not retain a stale risk snapshot. The investigation UI exposes the graph, evidence, transactions and case workflow.

## Architecture

```text
JSON transaction data
        ↓
Validated ingestion / loading
        ↓
NetworkX MultiDiGraph
        ↓
Graph heuristics + GraphSAGE-style encoder
(cycles, shared devices/IPs, velocity, flows, geography + learned embeddings)
        ↓
Explainable network risk score (account signal + coordinated-network evidence + optional GNN)
        ↓
Alerts / Investigation / Network visualization
        ↓
Case management + evidence + timeline
```

FastAPI provides the HTTP API. The authenticated Next.js app is the only supported analyst interface; the old static browser UI and its demo access code are retired. JSON files are still used for the local MVP data store.

Customer sign-up and sign-in are separate from the analyst sign-in. Customer passwords use `hashlib.scrypt`; session tokens are random, stored as hashes in SQLite, and sent in an httpOnly cookie. Each customer transaction query is scoped on the backend to that user's linked accounts. Customer portal reads and case actions are stored in a SHA-256 hash-linked audit trail; the service verifies it at startup and pauses audit writes if verification fails. This detects record edits but does not prevent a database operator from rewriting the full chain, so production needs protected storage and externally anchored checkpoints. The analyst login and analyst APIs retain their existing shared local analyst credential and API-key setup. The customer store is SQLite-only today; a PostgreSQL adapter, email verification, password recovery, account deletion, analyst action auditing, and independent security review are not included yet.

### Next.js command terminal

The `frontend/` directory contains the Next.js 15 App Router terminal. In development it proxies `/api/*` through Next.js to FastAPI using the server-only `FIN_API_INTERNAL_URL`; the browser does not need a direct cross-origin API URL. The terminal includes a national relationship graph, an account-focused fraud-network graph, Cmd/Ctrl+K command palette, transaction activity, network-risk explanation, and Lightweight Charts visualization.

Start the API in one PowerShell window from this directory:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

In a second window, start the Next.js terminal:

```powershell
cd frontend
pnpm install
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
# First run only: creates a local analyst account and shared API key.
.\setup-local-login.ps1
.\restart-local.ps1
```

The setup script prompts for the username and password; it does not install a
default login. Do not rerun it unless you intend to replace the saved local
credentials. On later starts, run `.\restart-local.ps1` from `frontend/`. It
loads settings from `.env.local`, clears inherited FinSentinels environment
overrides for the frontend process, and replaces a stale local Next.js server
on the selected port when that process belongs to this checkout. If another
application owns the port, the script stops and reports it instead of
terminating the unrelated process.

Open the URL printed by `pnpm dev` (normally `http://127.0.0.1:3000/`). If Next.js selects another port because 3000 is occupied, use the printed port; set `FIN_SENTINELS_FRONTEND_URL` in the backend environment to that URL if you want the FastAPI root to redirect there. For a production frontend build, run `pnpm build` in `frontend/`, then `pnpm start` after the API is available.

The public landing page is `/`; customer registration and sign-in are `/signup` and `/login`; customer pages live at `/dashboard`, `/dashboard/transactions`, and `/dashboard/settings`. Analyst access stays at `/analyst-login` and `/terminal`. Create a customer account from `/signup`; each account receives two unshared synthetic sample accounts. When the bundled account list is exhausted, the service creates uniquely identified synthetic accounts using transaction patterns from the bundled sample set, so separate customers never share those generated account IDs.

Customer preview data is stored at `data/customer-portal-demo.sqlite3` in local demo mode and under the persistent runtime data directory in a production container. Back up that directory if you need to retain demo logins. It is safe to reset the local customer demo by stopping the API and deleting that SQLite file; this removes customer accounts and sessions. Do not delete the production database to reset or troubleshoot it.

The deployment configuration keeps the analyst graph empty in production until a verified data feed is connected. The public customer preview still uses only the bundled synthetic sample set; it is separate from the analyst graph and must not be replaced with real customer data. Public sign-up is therefore currently a synthetic-data preview, not live bank onboarding. The public landing-page summary publishes aggregate counts only in demo mode; it does not return individual production account or transaction data. The deployment continues to use SQLite for customer accounts, so run a single API worker and a single host; horizontal database-backed scaling needs a PostgreSQL implementation and migration work.

## Deploy a private single-host pilot with Docker

The supported hosted path is a single Linux host running Docker Compose. It runs the Next.js terminal and FastAPI as separate containers, keeps the API on the private Compose network, and stores cases, settings, evidence files, and ingested transactions in the persistent `runtime-data` volume.

On Windows PowerShell, from this directory:

```powershell
.\setup-deploy-env.ps1
docker compose up --build -d
docker compose ps
```

Open `http://localhost:3000`. The setup script asks for an analyst username/password and generates independent session and backend API secrets; it does not install a shared default login. Keep the generated `.env` private. To stop the services without deleting investigation data, use `docker compose down`. **Do not use `docker compose down -v` unless you intend to erase the persistent data volume.**

For an internet-facing deployment, put a maintained TLS reverse proxy in front of the web container, point `PUBLIC_APP_URL` at the HTTPS hostname, and set `FIN_SENTINELS_COOKIE_SECURE=true`. Keep the API port private; the compose file does not publish it. Configure backups for the Docker `runtime-data` volume and test restores before storing operational evidence.

### Publish the pilot at finsentinels.in

The GoDaddy domain is the address; it does not provide the server that runs Fin Sentinels. The current app is prepared for a **single Linux VPS** running Docker Compose, with Caddy on the host providing HTTPS. This keeps FastAPI private and exposes only the website through the domain.

1. Create an Ubuntu Linux VPS with a public IPv4 address, install Docker Engine with the Compose plugin, and allow inbound ports 80 and 443. Keep SSH restricted to your own address where the provider allows it. Do not open ports 3000 or 8000 to the internet.
2. Upload or clone this project onto the server. On your Windows computer, run `setup-deploy-env.ps1` once to create a private `.env` with a unique analyst login and generated secrets. Edit it so `PUBLIC_APP_URL=https://finsentinels.in/` and `FIN_SENTINELS_COOKIE_SECURE=true`; keep `WEB_BIND_ADDRESS=127.0.0.1`. Transfer `.env` to the server over SSH/SCP and never commit it to GitHub.
3. In GoDaddy's DNS page, point an `A` record with host `@` to the VPS IPv4 address, and set a `CNAME` record for host `www` pointing to `finsentinels.in`. If your domain uses different nameservers, make the DNS change at the provider listed there. Replace conflicting website records; leave email MX/TXT records alone. Only add an AAAA record if the VPS has working public IPv6.
4. On the VPS, run `docker compose up --build -d` from the project folder. Wait until `docker compose ps` shows both `web` and `api` healthy.
5. Install Caddy on the VPS, copy this project's `Caddyfile` to `/etc/caddy/Caddyfile`, and reload Caddy. Once public DNS points to the VPS and ports 80/443 are reachable, Caddy obtains and renews the HTTPS certificate automatically. Then open `https://finsentinels.in` or `https://www.finsentinels.in`.

This pilot still has one shared analyst account and a single-host JSON-backed analyst data store. Demo transactions are local-only; production mode starts empty until an authorized feed is connected. Do not use real customer/bank data with a public team yet. The app needs separate analyst accounts and roles, analyst-action auditing with externally anchored integrity checks, a transactional database, tested encrypted backups, and a validated authorized bank feed before operational use. The current risk ranking is not a calibrated fraud probability; keep a human analyst in the decision loop.

This is a **single-analyst, single-host pilot**. Docker deployments default to `FINSENTINELS_DATA_MODE=production`: bundled synthetic transactions are excluded and the graph starts empty until records are ingested. The GNN is disabled in production until a deployment-specific baseline has been validated; rule-based evidence remains available. Local development defaults to `demo` mode. The JSON-backed runtime store is designed for one API worker and one host; do not scale it to multiple API replicas. The login is one shared environment-configured analyst account, so add individual identities, role-based authorization, analyst-action auditing, a transactional database, and an externally anchored audit trail before onboarding a real analyst team or handling regulated production records. A real OBP feed also requires bank-issued OAuth access and correctly signed webhook delivery.

The production API container installs only runtime dependencies; it does not bundle PyTorch or train against demo data. This keeps cloud builds and startup lighter. Local demo mode can install PyTorch through `requirements.txt` to show the optional unsupervised ranking. End users access the site through their browser and do not download the Python environment. If the GNN cannot initialize, the API intentionally remains available with graph-rule scoring and reports that the model is unavailable.

### Live source feed

`POST /api/ingest` remains the normalized connector boundary. The OBP adapter adds signed webhook intake at `/api/integrations/obp/webhook` and authorized account-ledger polling at `/api/integrations/obp/sync`. It accepts both identifier-only OBP notifications (then fetches transaction detail via the OBP REST API) and enriched event envelopes. Raw provider request bodies are not persisted or returned to analysts; only normalized transaction fields and source/event identifiers are stored. A transaction is added to the directed graph only when debit/credit direction is explicit or the settlement amount is signed. Positive unsigned amounts without a direction flag are rejected instead of guessed.

### Open Bank Project connector setup

Copy the values from `OBP_ENV.example` into the ignored `backend.local.env` (local) or deployment secret store and fill them with values issued by your OBP sandbox/core administrator. Do not commit real tokens or shared secrets. The connector requires an OAuth 2 access token already granted access to the configured bank, accounts, and transaction view. Historical polling is manual from **SYNC LEDGER** in the signed-in workspace. The webhook callback URL is `/api/integrations/obp/webhook`; the receiver verifies HMAC-SHA256 over the exact raw request body. If the OBP notification service does not sign callbacks, place an authenticated signing gateway in front of this route. Never expose the webhook without signature verification.

The sample enriched event format is supported, but it must carry a signed settlement amount or explicit `details.credit_debit_indicator`/`details.direction`. `details.type` describes the transaction category and is not treated as direction. OBP's identifier-only webhook requires the transaction REST lookup to supply its signed value and counterparty. No bank connection is active until real OAuth consent, bank/view/account identifiers, and webhook delivery are configured; the bundled graph remains the local workspace dataset until then.

The settlement currency and instructed currency are both retained. INR is the current canonical scoring/display currency. For other settlement currencies the adapter may obtain a daily reference rate from ExchangeRate-API; if lookup fails, the original transaction is retained with an unavailable INR reference, and foreign value is excluded from INR volume totals. FX divergence is computed only when a reference conversion is available. Reference rates are indicative and not bank settlement rates.

`GET /api/intelligence` returns the aggregate snapshot for the currently loaded national graph. Its scope is limited to the sources connected to this deployment.

## Current data

The packaged demo dataset is loaded only when `FINSENTINELS_DATA_MODE=demo` (the local development default). It contains:

- 99 account IDs: `ACC_001` through `ACC_099`
- The backend combines `data/normal_transactions.json` (baseline population) with `data/mock_transactions.json` (fraud scenarios) into one graph.
- 376 transaction records
- Device, merchant and location relationships
- A deliberate three-account fraud ring: `ACC_097 → ACC_098 → ACC_099 → ACC_097`
- Mule/watch patterns for demonstration

## Run

### Windows

Double-click `run.bat` from this project folder, or run `.\run.bat` in PowerShell. It starts or reuses the local FastAPI service, starts the secured Next.js frontend with the saved local settings, waits for the login page, then opens it in your browser. Keep the API and frontend windows open while using the app.

For first-time setup only, if local sign-in has not been configured, run `frontend/setup-local-login.ps1` and choose a username and password. Do not rerun it unless you want to replace the saved credentials. The launcher does not install packages automatically; install backend requirements and run `pnpm install` in `frontend/` if the local environments have not been set up yet.

### Manual

```powershell
python -m pip install -r requirements.txt
python verify.py
python -m unittest discover -s tests -v
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Start the Next.js frontend as described above and open the URL printed by `pnpm dev`.

## Local analyst login

There is no built-in demo password. Run `frontend/setup-local-login.ps1` to configure analyst credentials plus a private Next.js-to-FastAPI key. It writes secrets only to ignored `frontend/.env.local` and `backend.local.env`. Restart FastAPI after setup, then run `frontend/restart-local.ps1` so Next.js loads the saved settings. If the login page says local sign-in settings are unavailable, use that restart script rather than rerunning setup; rerunning setup replaces the saved password. FastAPI rejects direct `/api/*` requests without the private proxy key; the signed OBP webhook is verified separately. Local credentials are separate from the generated production credentials in `.env`.

## GNN integration

The backend includes a local **GraphSAGE-style encoder** in `ml_engine.py`, implemented with PyTorch (no `torch-geometric` dependency). In demo mode it trains an unsupervised graph-structure objective on `data/normal_transactions.json` and embeds the current graph with transfer topology, shared-device/IP exposure, and cross-border activity. The dashboard displays the GNN anomaly ranking alongside the explainable network evidence. Production mode does not train on this synthetic baseline; enable a model only after validating a deployment-specific reference dataset.

In demo mode, the account-level signal combines `80% graph-rule score + 20% GNN anomaly score`; the published network score adds explicit coordinated-device, shared-IP, and cross-border components. The GNN feature vector also tracks currency mismatch, reference FX divergence, and foreign values without a base-currency conversion. Production mode uses graph-rule evidence only until a deployment-specific model baseline is validated. If PyTorch is unavailable or model initialization fails in demo mode, the API keeps running with graph-rule scoring. Install the dependencies with `python -m pip install -r requirements.txt`. Demo GNN training runs in the background so API startup and rule-based analysis remain available while the model initializes.

**Important limitation:** this is an unsupervised structural-anomaly signal, not a supervised fraud classifier. Its score is a relative ranking from synthetic demo data, not a calibrated probability of fraud. Before claiming measured accuracy, train/evaluate with labeled fraud and non-fraud examples using a leakage-safe split and report precision, recall, F1 and PR-AUC. The current 99-account demo is suitable for integration testing, not scientific validation.

Near-real-time monitoring uses the push-based transaction feed and `GET /api/stream/intelligence` SSE endpoint. The Agent Signals workbench loads network-risk, graph-structure, and account-behavior explanations for every account in the current graph, then refreshes affected accounts as new transactions arrive. The OBP adapter is implemented but no provider account is currently connected. The streamed explainable agent widgets are deterministic, graph-grounded Pydantic outputs. No external LLM, LangGraph/Instructor agent runtime, news provider, SEC RAG index, or vector database is configured in this repository.

## Security and production boundary

- Pydantic request validation
- Account ID normalization
- Account-only case creation
- Controlled FastAPI errors
- Runtime data isolated in a configurable data directory; writes fail visibly if persistent storage is unavailable
- No raw SQL surface in the MVP

The hosted pilot uses a signed HTTP-only analyst session cookie, customer session cookies, and a private Next.js-to-FastAPI API key. Customer portal reads and case actions have a hash-linked SQLite audit trail, but analyst actions are not yet centrally audited and there is no external audit checkpoint. This does not provide individual analyst accounts, managed secret rotation, encrypted backups, or an independent security review; those controls and a transactional customer database are required before a financial institution uses it operationally.

## Roadmap for a real-world pilot

1. **Connect an authorized source:** start with bank-issued sandbox credentials and explicit account consent; verify signed webhooks and reconciliation against the bank ledger before expanding access.
2. **Protect operational data:** replace the JSON runtime store with a transactional database, add per-analyst identities and roles, extend audit coverage to analyst actions with externally anchored checkpoints, define retention controls, and validate encrypted backups with a recovery drill.
3. **Validate the model:** evaluate on labeled, representative historical cases with a time-based, leakage-safe split. Report precision, recall, false-positive rates, and drift by cohort; keep analysts responsible for decisions and provide a clear review trail.
4. **Run a limited pilot:** restrict access to a small authorized analyst group, monitor data quality and service health, and have the institution review privacy, security, and regulatory obligations before using customer data.

The bundled records are synthetic demo data and are excluded in production mode. All current scores are investigation rankings, not calibrated fraud probabilities, and must not trigger automatic account blocks or customer decisions.
