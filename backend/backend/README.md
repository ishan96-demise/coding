# FinSentinels — SIH 2026 PS-29

FinSentinels is an explainable graph-based financial fraud investigation platform for Smart India Hackathon Problem Statement 29: **AI-Based Financial Fraud Network Detection**.

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

### Next.js command terminal

The `frontend/` directory contains the Next.js 15 App Router terminal. In development it proxies `/api/*` through Next.js to FastAPI using the server-only `FIN_API_INTERNAL_URL`; the browser does not need a direct cross-origin API URL. The terminal includes a national relationship graph, an account-focused fraud-network graph, Cmd/Ctrl+K command palette, transaction activity, network-risk explanation, and Lightweight Charts visualization.

Start the API in one PowerShell window from this directory:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

In a second window, start the Next.js terminal:

```powershell
cd frontend
pnpm install
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
# First run only: creates a local analyst account and shared API key.
.\setup-local-login.ps1
pnpm dev
```

The setup script prompts for the username and password; it does not install a
default login. Do not rerun it unless you intend to replace the saved local
credentials. On later starts, run only `pnpm dev` from `frontend/`.

Open the URL printed by `pnpm dev` (normally `http://127.0.0.1:3000/`). If Next.js selects another port because 3000 is occupied, use the printed port; set `FIN_SENTINELS_FRONTEND_URL` in the backend environment to that URL if you want the FastAPI root to redirect there. For a production frontend build, run `pnpm build` in `frontend/`, then `pnpm start` after the API is available.

### Live source feed

`POST /api/ingest` remains the normalized connector boundary. The OBP adapter adds signed webhook intake at `/api/integrations/obp/webhook` and authorized account-ledger polling at `/api/integrations/obp/sync`. It accepts both identifier-only OBP notifications (then fetches transaction detail via the OBP REST API) and enriched event envelopes. Raw provider request bodies are not persisted or returned to analysts; only normalized transaction fields and source/event identifiers are stored. A transaction is added to the directed graph only when debit/credit direction is explicit or the settlement amount is signed. Positive unsigned amounts without a direction flag are rejected instead of guessed.

### Open Bank Project connector setup

Copy the values from `OBP_ENV.example` into the ignored `backend.local.env` (local) or deployment secret store and fill them with values issued by your OBP sandbox/core administrator. Do not commit real tokens or shared secrets. The connector requires an OAuth 2 access token already granted access to the configured bank, accounts, and transaction view. Historical polling is manual from **SYNC LEDGER** in the signed-in workspace. The webhook callback URL is `/api/integrations/obp/webhook`; the receiver verifies HMAC-SHA256 over the exact raw request body. If the OBP notification service does not sign callbacks, place an authenticated signing gateway in front of this route. Never expose the webhook without signature verification.

The sample enriched event format is supported, but it must carry a signed settlement amount or explicit `details.credit_debit_indicator`/`details.direction`. `details.type` describes the transaction category and is not treated as direction. OBP's identifier-only webhook requires the transaction REST lookup to supply its signed value and counterparty. No bank connection is active until real OAuth consent, bank/view/account identifiers, and webhook delivery are configured; the bundled graph remains the local workspace dataset until then.

The settlement currency and instructed currency are both retained. INR is the current canonical scoring/display currency. For other settlement currencies the adapter may obtain a daily reference rate from ExchangeRate-API; if lookup fails, the original transaction is retained with an unavailable INR reference, and foreign value is excluded from INR volume totals. FX divergence is computed only when a reference conversion is available. Reference rates are indicative and not bank settlement rates.

`GET /api/intelligence` returns the aggregate snapshot for the currently loaded national graph. Its scope is limited to the sources connected to this deployment.

## Current data

The packaged dataset contains:

- 99 account IDs: `ACC_001` through `ACC_099`
- The backend combines `data/normal_transactions.json` (baseline population) with `data/mock_transactions.json` (fraud scenarios) into one graph.
- 376 transaction records
- Device, merchant and location relationships
- A deliberate three-account fraud ring: `ACC_097 → ACC_098 → ACC_099 → ACC_097`
- Mule/watch patterns for demonstration

## Run

### Windows

```powershell
cd E:\coding\backend\backend
.\run.bat
```

The launcher creates a local virtual environment, installs requirements, runs verification, then starts Uvicorn.

### Manual

```powershell
python -m pip install -r requirements.txt
python verify.py
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Start the Next.js frontend as described above and open the URL printed by `pnpm dev`.

## Local analyst login

There is no built-in demo password. Run `frontend/setup-local-login.ps1` to configure analyst credentials plus a private Next.js-to-FastAPI key. It writes secrets only to ignored `frontend/.env.local` and `backend.local.env`. Restart both servers after setup. FastAPI rejects direct `/api/*` requests without the private proxy key; the signed OBP webhook is verified separately. For a throwaway local install, use a unique password and do not reuse production credentials.

## GNN integration

The backend includes a local **GraphSAGE-style encoder** in `ml_engine.py`, implemented with PyTorch (no `torch-geometric` dependency). It trains an unsupervised graph-structure objective on `data/normal_transactions.json` and embeds the current graph with transfer topology, shared-device/IP exposure, and cross-border activity. The dashboard displays the GNN anomaly ranking alongside the explainable network evidence.

The account-level signal combines `80% graph-rule score + 20% GNN anomaly score`; the published network score adds explicit coordinated-device, shared-IP, and cross-border components. The GNN feature vector also tracks currency mismatch, reference FX divergence, and foreign values without a base-currency conversion. If PyTorch is unavailable or model initialization fails, the API keeps running with graph-rule scoring. Install the dependencies with `python -m pip install -r requirements.txt`. The first startup trains the small model and may take a moment.

**Important limitation:** this is an unsupervised structural-anomaly signal, not a supervised fraud classifier. Its score is a relative ranking from synthetic demo data, not a calibrated probability of fraud. Before claiming measured accuracy, train/evaluate with labeled fraud and non-fraud examples using a leakage-safe split and report precision, recall, F1 and PR-AUC. The current 99-account demo is suitable for integration testing, not scientific validation.

Near-real-time monitoring uses the push-based transaction feed and `GET /api/stream/intelligence` SSE endpoint. The OBP adapter is implemented but no provider account is currently connected. The streamed explainable agent widgets are deterministic, graph-grounded Pydantic outputs. No external LLM, LangGraph/Instructor agent runtime, news provider, SEC RAG index, or vector database is configured in this repository.

## Security and validation

- Pydantic request validation
- Account ID normalization
- Account-only case creation
- Controlled FastAPI errors
- Local data-file isolation under `data/`
- No raw SQL surface in the MVP

Production hardening would add authentication, RBAC, secrets management, audit logging, encryption and persistent transactional storage.
