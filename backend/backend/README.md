# FinSentinels — SIH 2026 PS-29

FinSentinels is an explainable graph-based financial fraud investigation platform for Smart India Hackathon Problem Statement 29: **AI-Based Financial Fraud Network Detection**.

## What the MVP actually does

The system turns transaction records into a typed NetworkX `MultiDiGraph` and analyzes relationships rather than scoring each transaction in isolation.

Supported graph entities:

- Accounts
- Devices
- Merchants
- Locations

Supported detection signals:

- Circular fund routing / fraud rings
- Shared-device reuse
- Transaction velocity
- Network connectivity / centrality
- Mule-account flow behavior
- High-value transaction context

Every account analysis produces a numeric risk score plus human-readable reasons. The investigation UI exposes the graph, evidence, transactions and case workflow.

## Architecture

```text
JSON transaction data
        ↓
Validated ingestion / loading
        ↓
NetworkX MultiDiGraph
        ↓
Graph heuristics
(cycles, shared devices, velocity, flow, centrality)
        ↓
Explainable risk score
        ↓
Alerts / Investigation / Network visualization
        ↓
Case management + evidence + timeline
```

FastAPI provides the HTTP API and serves the frontend. JSON files are intentionally used for the hackathon MVP so the implementation stays easy to explain and inspect.

## Current data

The packaged dataset contains:

- 99 account IDs: `ACC_001` through `ACC_099`
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

Open `http://127.0.0.1:8000/`.

## Demo login

- Analyst: `R. Kulkarni`
- Access code: `FINSENTINELS`

## Important positioning for judges

The current MVP is **explainable graph analytics**, not a fabricated GNN. The dashboard therefore does not claim that GraphSAGE/GCN is already running in production code. The roadmap is to add learned node embeddings and a GNN scoring layer in Phase 2.

Near-real-time monitoring is implemented using API polling. A future streaming adapter can connect the same graph and case APIs to a queue or event bus.

## Security and validation

- Pydantic request validation
- Account ID normalization
- Account-only case creation
- Controlled FastAPI errors
- Local data-file isolation under `data/`
- No raw SQL surface in the MVP

Production hardening would add authentication, RBAC, secrets management, audit logging, encryption and persistent transactional storage.
