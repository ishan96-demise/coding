from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import networkx as nx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from graph_builder import (
    analyze_account,
    find_data_file,
    get_account_transactions,
    get_alert_subgraph,
    get_full_graph,
    get_subgraph,
    load_graph_data,
    load_transactions,
)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
INDEX_FILE = BASE_DIR / "index.html"
APP_JS_FILE = BASE_DIR / "app.js"

IS_VERCEL = os.getenv("VERCEL") == "1"

TMP_DIR = (
    Path("/tmp/finsentinels_runtime")
    if IS_VERCEL
    else Path(tempfile.gettempdir()) / "finsentinels_runtime"
)

SETTINGS_FILENAME = "settings.json"
CASE_FILENAME = "cases.json"

DEFAULT_SETTINGS = {
    "high_threshold": 65,
    "watch_threshold": 35,
    "graph_depth": 2,
}

ALLOWED_CASE_STATUSES = {
    "OPEN",
    "INVESTIGATING",
    "CLOSED",
    "DISMISSED",
}

ALLOWED_PRIORITIES = {
    "LOW",
    "MEDIUM",
    "HIGH",
    "CRITICAL",
}

FILE_LOCK = Lock()
IN_MEMORY_STORAGE: dict[str, Any] = {}

app = FastAPI(
    title="FinSentinels",
    description="Explainable graph-based financial fraud network detection and investigation API",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if STATIC_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=str(STATIC_DIR), html=False),
        name="static",
    )


class CaseCreate(BaseModel):
    account_id: str = Field(min_length=1, max_length=100)
    priority: str = "HIGH"
    note: str = Field(default="", max_length=5000)

    @field_validator("account_id")
    @classmethod
    def normalize_account(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, value: str) -> str:
        value = value.strip().upper()
        if value not in ALLOWED_PRIORITIES:
            raise ValueError(
                f"Priority must be one of: {', '.join(sorted(ALLOWED_PRIORITIES))}"
            )
        return value


class CaseUpdate(BaseModel):
    status: str | None = None
    note: str | None = Field(default=None, max_length=5000)
    priority: str | None = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str | None) -> str | None:
        if value is None:
            return None

        value = value.strip().upper()

        if value not in ALLOWED_CASE_STATUSES:
            raise ValueError(
                f"Status must be one of: {', '.join(sorted(ALLOWED_CASE_STATUSES))}"
            )

        return value

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, value: str | None) -> str | None:
        if value is None:
            return None

        value = value.strip().upper()

        if value not in ALLOWED_PRIORITIES:
            raise ValueError(
                f"Priority must be one of: {', '.join(sorted(ALLOWED_PRIORITIES))}"
            )

        return value


class EvidenceCreate(BaseModel):
    evidence_type: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=5000)

    @field_validator("evidence_type", "description")
    @classmethod
    def trim_text(cls, value: str) -> str:
        value = value.strip()

        if not value:
            raise ValueError("Value cannot be empty")

        return value


class SettingsUpdate(BaseModel):
    high_threshold: int = Field(ge=1, le=100)
    watch_threshold: int = Field(ge=0, le=99)
    graph_depth: int = Field(ge=1, le=5)


class IngestTransaction(BaseModel):
    transaction_id: str = Field(min_length=1, max_length=120)
    source_account: str = Field(min_length=1, max_length=100)
    target_account: str = Field(min_length=1, max_length=100)
    amount: float = Field(gt=0)
    timestamp: str
    device_id: str | None = None
    ip_address: str | None = None
    merchant_id: str | None = None
    location: str | None = None


class IngestBatch(BaseModel):
    transactions: list[IngestTransaction] = Field(
        min_length=1,
        max_length=5000,
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json_file(filename: str, default: Any) -> Any:
    if filename in IN_MEMORY_STORAGE:
        return IN_MEMORY_STORAGE[filename]

    runtime_path = TMP_DIR / filename
    bundled_path = DATA_DIR / filename

    # Runtime state has priority over bundled seed data.
    paths = [runtime_path, bundled_path]

    for path in paths:
        if not path.exists():
            continue

        try:
            with path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)

            IN_MEMORY_STORAGE[filename] = data
            return data

        except (json.JSONDecodeError, OSError):
            continue

    IN_MEMORY_STORAGE[filename] = default
    return default


def write_json_file(filename: str, data: Any) -> None:
    # Always keep the latest state in memory.
    IN_MEMORY_STORAGE[filename] = data

    # Local: data/
    # Vercel: /tmp/
    target = TMP_DIR / filename if IS_VERCEL else DATA_DIR / filename

    try:
        target.parent.mkdir(parents=True, exist_ok=True)

        temp = target.with_suffix(target.suffix + ".tmp")

        with FILE_LOCK:
            with temp.open("w", encoding="utf-8") as handle:
                json.dump(
                    data,
                    handle,
                    indent=2,
                    ensure_ascii=False,
                )

            os.replace(temp, target)

    except (OSError, PermissionError):
        # Keep in-memory state even if filesystem persistence fails.
        pass


def get_settings() -> dict[str, Any]:
    saved = read_json_file(SETTINGS_FILENAME, {})

    if not isinstance(saved, dict):
        saved = {}

    settings = {
        **DEFAULT_SETTINGS,
        **saved,
    }

    settings["high_threshold"] = int(
        settings.get("high_threshold", DEFAULT_SETTINGS["high_threshold"])
    )

    settings["watch_threshold"] = int(
        settings.get("watch_threshold", DEFAULT_SETTINGS["watch_threshold"])
    )

    settings["graph_depth"] = int(
        settings.get("graph_depth", DEFAULT_SETTINGS["graph_depth"])
    )

    if settings["watch_threshold"] >= settings["high_threshold"]:
        settings["watch_threshold"] = max(
            0,
            settings["high_threshold"] - 1,
        )

    return settings


def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    write_json_file(SETTINGS_FILENAME, settings)
    return settings


def load_cases() -> list[dict[str, Any]]:
    data = read_json_file(CASE_FILENAME, [])

    if not isinstance(data, list):
        return []

    return data


def save_cases(cases: list[dict[str, Any]]) -> None:
    write_json_file(CASE_FILENAME, cases)


def status_from_score(
    score: int | float,
    settings: dict[str, Any],
) -> str:
    value = float(score)

    if value >= settings["high_threshold"]:
        return "HIGH RISK"

    if value >= settings["watch_threshold"]:
        return "WATCH"

    return "SAFE"


def analyze_with_settings(
    G,
    account_id: str,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = settings or get_settings()

    result = analyze_account(G, account_id)

    if result.get("status") == "NOT FOUND":
        return result

    result["status"] = status_from_score(
        result.get("risk_score", 0),
        settings,
    )

    return result


def next_case_id(cases: list[dict[str, Any]]) -> str:
    highest = 0

    for case in cases:
        if not isinstance(case, dict):
            continue

        value = str(case.get("case_id", ""))

        if not value.startswith("CASE-"):
            continue

        try:
            number = int(value.split("-", 1)[1])
            highest = max(highest, number)
        except (IndexError, ValueError):
            pass

    return f"CASE-{highest + 1:04d}"


def add_timeline_event(
    case: dict[str, Any],
    title: str,
    description: str,
    event_type: str = "CASE_EVENT",
) -> None:
    if not isinstance(case.get("timeline"), list):
        case["timeline"] = []

    events = case["timeline"]

    events.append(
        {
            "event_id": f"EVT-{len(events) + 1:04d}",
            "type": event_type,
            "title": title,
            "description": description,
            "timestamp": utc_now(),
        }
    )


def build_case_timeline(
    G,
    account_id: str,
    case: dict[str, Any],
) -> list[dict[str, Any]]:
    events = list(case.get("timeline") or [])

    if not events:
        events.append(
            {
                "event_id": "EVT-0001",
                "type": "CASE_CREATED",
                "title": "Case created",
                "description": f"Investigation opened for {account_id}.",
                "timestamp": case.get("created_at") or utc_now(),
            }
        )

    return sorted(
        events,
        key=lambda x: x.get("timestamp") or "",
    )


# -------------------------------------------------------------------
# FRONTEND
# -------------------------------------------------------------------

@app.get("/")
@app.get("/api")
@app.get("/api/")
@app.get("/api/index.py")
def dashboard():
    if not INDEX_FILE.exists():
        raise HTTPException(
            status_code=500,
            detail=f"index.html not found at {INDEX_FILE}",
        )

    return FileResponse(
        str(INDEX_FILE),
        media_type="text/html",
    )


@app.get("/app.js")
@app.get("/api/app.js")
def app_js():
    if not APP_JS_FILE.exists():
        raise HTTPException(
            status_code=404,
            detail=f"app.js not found at {APP_JS_FILE}",
        )

    return FileResponse(
        str(APP_JS_FILE),
        media_type="application/javascript",
    )


# -------------------------------------------------------------------
# HEALTH
# -------------------------------------------------------------------

@app.get("/api/health")
def health():
    try:
        G = load_graph_data()
        transactions = load_transactions()

        return {
            "status": "healthy",
            "service": "FinSentinels API",
            "version": app.version,
            "nodes": G.number_of_nodes(),
            "edges": G.number_of_edges(),
            "transactions": len(transactions),
            "data_file": os.path.basename(find_data_file()),
            "vercel": IS_VERCEL,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# DATA QUALITY
# -------------------------------------------------------------------

@app.get("/api/data-quality")
def data_quality():
    try:
        transactions = load_transactions()

        ids = [
            tx["transaction_id"]
            for tx in transactions
        ]

        duplicate_count = len(ids) - len(set(ids))

        accounts = {
            tx["source_account"]
            for tx in transactions
        } | {
            tx["target_account"]
            for tx in transactions
        }

        return {
            "status": "valid" if duplicate_count == 0 else "invalid",
            "transaction_count": len(transactions),
            "unique_transaction_ids": len(set(ids)),
            "duplicate_transaction_ids": duplicate_count,
            "account_count": len(accounts),
            "data_file": find_data_file(),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# INVESTIGATION
# -------------------------------------------------------------------

@app.get("/api/score/{account_id}")
def score(account_id: str):
    try:
        G = load_graph_data()
        settings = get_settings()

        aid = account_id.strip().upper()

        result = analyze_with_settings(
            G,
            aid,
            settings,
        )

        if result.get("status") == "NOT FOUND":
            raise HTTPException(
                status_code=404,
                detail=result["reasons"][0],
            )

        result["graph"] = get_subgraph(
            G,
            aid,
            depth=settings["graph_depth"],
        )

        result["transactions"] = get_account_transactions(
            G,
            aid,
        )

        result["settings"] = settings

        return result

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/graph/{account_id}")
@app.get("/api/transaction/{account_id}")
def graph(account_id: str):
    try:
        G = load_graph_data()
        settings = get_settings()

        aid = account_id.strip().upper()

        if (
            aid not in G
            or G.nodes[aid].get("type") != "account"
        ):
            raise HTTPException(
                status_code=404,
                detail=f"Account '{aid}' not found",
            )

        return {
            "account_id": aid,
            "graph": get_subgraph(
                G,
                aid,
                depth=settings["graph_depth"],
            ),
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# NETWORK
# -------------------------------------------------------------------

@app.get("/api/network")
def network(scope: str = "alerts"):
    try:
        G = load_graph_data()
        normalized = str(
            scope or "alerts"
        ).strip().lower()

        if normalized == "full":
            graph_data = get_full_graph(G)

        else:
            settings = get_settings()

            alert_ids = set()

            for aid, node_data in G.nodes(data=True):
                if node_data.get("type") != "account":
                    continue

                result = analyze_with_settings(
                    G,
                    aid,
                    settings,
                )

                if result["status"] == "HIGH RISK":
                    alert_ids.add(aid)

            if not alert_ids:
                for aid, node_data in G.nodes(data=True):
                    if node_data.get("type") != "account":
                        continue

                    result = analyze_with_settings(
                        G,
                        aid,
                        settings,
                    )

                    if result["status"] == "WATCH":
                        alert_ids.add(aid)

            graph_data = get_alert_subgraph(
                G,
                alert_ids,
                depth=1,
            )

        return {
            "scope": normalized,
            "graph": graph_data,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# ACCOUNTS
# -------------------------------------------------------------------

@app.get("/api/accounts")
def accounts():
    try:
        G = load_graph_data()
        settings = get_settings()

        rows = []

        for account_id, node_data in G.nodes(data=True):
            if node_data.get("type") != "account":
                continue

            result = analyze_with_settings(
                G,
                account_id,
                settings,
            )

            rows.append(
                {
                    "account_id": account_id,
                    "risk_score": result["risk_score"],
                    "status": result["status"],
                    "mule_account": result.get(
                        "mule_account",
                        False,
                    ),
                }
            )

        rows.sort(
            key=lambda item: item["account_id"]
        )

        return {
            "count": len(rows),
            "accounts": rows,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# RECENT TRANSACTIONS
# -------------------------------------------------------------------

@app.get("/api/transactions/recent")
def recent_transactions(limit: int = 12):
    try:
        limit = max(
            1,
            min(int(limit), 50),
        )

        transactions = load_transactions()

        rows = list(
            reversed(
                transactions[-limit:]
            )
        )

        return {
            "count": len(rows),
            "transactions": rows,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# ALERTS
# -------------------------------------------------------------------

@app.get("/api/alerts")
def alerts():
    try:
        G = load_graph_data()
        settings = get_settings()

        output = []

        for aid, node_data in G.nodes(data=True):
            if node_data.get("type") != "account":
                continue

            result = analyze_with_settings(
                G,
                aid,
                settings,
            )

            if result["status"] not in {
                "HIGH RISK",
                "WATCH",
            }:
                continue

            output.append(
                {
                    "account_id": aid,
                    "risk_score": result["risk_score"],
                    "status": result["status"],
                    "reasons": result["reasons"],
                    "cycle_count": result.get(
                        "cycle_count",
                        0,
                    ),
                    "shared_device_count": len(
                        result.get(
                            "shared_devices",
                            [],
                        )
                    ),
                    "mule_account": result.get(
                        "mule_account",
                        False,
                    ),
                    "flow_metrics": result.get(
                        "flow_metrics",
                        {},
                    ),
                }
            )

        output.sort(
            key=lambda x: x["risk_score"],
            reverse=True,
        )

        return {
            "count": len(output),
            "alerts": output,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# ANALYTICS
# -------------------------------------------------------------------

@app.get("/api/analytics")
def analytics():
    try:
        G = load_graph_data()
        settings = get_settings()

        accounts_list = [
            n
            for n, d in G.nodes(data=True)
            if d.get("type") == "account"
        ]

        devices = [
            n
            for n, d in G.nodes(data=True)
            if d.get("type") == "device"
        ]

        merchants = [
            n
            for n, d in G.nodes(data=True)
            if d.get("type") == "merchant"
        ]

        locations = [
            n
            for n, d in G.nodes(data=True)
            if d.get("type") == "location"
        ]

        transfers = [
            d
            for _u, _v, _k, d in G.edges(
                keys=True,
                data=True,
            )
            if d.get("edge_type") == "TRANSFER"
        ]

        risk = {
            "high_risk": 0,
            "watch": 0,
            "safe": 0,
        }

        scores = []
        mule_accounts = 0

        for aid in accounts_list:
            result = analyze_with_settings(
                G,
                aid,
                settings,
            )

            scores.append(
                result["risk_score"]
            )

            risk_key = {
                "HIGH RISK": "high_risk",
                "WATCH": "watch",
                "SAFE": "safe",
            }[result["status"]]

            risk[risk_key] += 1

            mule_accounts += int(
                result.get(
                    "mule_account",
                    False,
                )
            )

        account_graph = nx.DiGraph()
        account_graph.add_nodes_from(
            accounts_list
        )

        for u, v, _k, d in G.edges(
            keys=True,
            data=True,
        ):
            if d.get("edge_type") == "TRANSFER":
                account_graph.add_edge(u, v)

        cycle_groups = [
            set(c)
            for c in nx.strongly_connected_components(
                account_graph
            )
            if len(c) > 1
        ]

        shared_device_details = []

        for device in devices:
            users = {
                source
                for source, _target, _key, edge
                in G.in_edges(
                    device,
                    keys=True,
                    data=True,
                )
                if (
                    edge.get("edge_type")
                    == "USED_DEVICE"
                    and G.nodes[source].get(
                        "type"
                    )
                    == "account"
                )
            }

            if len(users) > 1:
                shared_device_details.append(
                    {
                        "device_id": device,
                        "accounts": sorted(users),
                        "account_count": len(users),
                    }
                )

        total_volume = sum(
            float(
                tx.get("amount", 0)
            )
            for tx in transfers
        )

        cases = load_cases()

        return {
            "generated_at": utc_now(),
            "network": {
                "accounts": len(accounts_list),
                "devices": len(devices),
                "merchants": len(merchants),
                "locations": len(locations),
                "transactions": len(transfers),
                "connections": G.number_of_edges(),
            },
            "risk_distribution": risk,
            "fraud_patterns": {
                "active_cycles": len(
                    cycle_groups
                ),
                "shared_devices": len(
                    shared_device_details
                ),
                "mule_accounts": mule_accounts,
            },
            "transaction_metrics": {
                "total_volume": round(
                    total_volume,
                    2,
                ),
                "average_transaction": round(
                    total_volume / len(transfers),
                    2,
                )
                if transfers
                else 0,
            },
            "average_risk_score": round(
                sum(scores) / len(scores),
                2,
            )
            if scores
            else 0,
            "shared_device_details": shared_device_details,
            "case_metrics": {
                "total": len(cases),
                "open": sum(
                    1
                    for c in cases
                    if (
                        isinstance(c, dict)
                        and c.get("status")
                        in {
                            "OPEN",
                            "INVESTIGATING",
                        }
                    )
                ),
                "investigating": sum(
                    1
                    for c in cases
                    if (
                        isinstance(c, dict)
                        and c.get("status")
                        == "INVESTIGATING"
                    )
                ),
                "closed": sum(
                    1
                    for c in cases
                    if (
                        isinstance(c, dict)
                        and c.get("status")
                        == "CLOSED"
                    )
                ),
                "dismissed": sum(
                    1
                    for c in cases
                    if (
                        isinstance(c, dict)
                        and c.get("status")
                        == "DISMISSED"
                    )
                ),
            },
            "settings": settings,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# CASES
# -------------------------------------------------------------------

@app.get("/api/cases")
def get_cases():
    try:
        cases = load_cases()

        cases.sort(
            key=lambda item: (
                item.get("created_at", "")
                if isinstance(item, dict)
                else ""
            ),
            reverse=True,
        )

        return {
            "count": len(cases),
            "cases": cases,
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/cases/{case_id}")
def get_case(case_id: str):
    try:
        cases = load_cases()

        target_id = case_id.strip()

        item = next(
            (
                case
                for case in cases
                if (
                    isinstance(case, dict)
                    and case.get("case_id")
                    == target_id
                )
            ),
            None,
        )

        if not item:
            raise HTTPException(
                status_code=404,
                detail=f"Case '{target_id}' not found",
            )

        G = load_graph_data()

        aid = str(
            item.get(
                "account_id",
                "",
            )
        ).strip().upper()

        analysis = (
            analyze_with_settings(
                G,
                aid,
                get_settings(),
            )
            if aid in G
            else None
        )

        result = dict(item)

        if not isinstance(
            result.get("evidence"),
            list,
        ):
            result["evidence"] = []

        if not isinstance(
            result.get("timeline"),
            list,
        ):
            result["timeline"] = []

        result["timeline"] = build_case_timeline(
            G,
            aid,
            result,
        )

        if analysis:
            result["analysis"] = analysis

        return result

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.post("/api/cases")
def create_case(case: CaseCreate):
    try:
        G = load_graph_data()
        settings = get_settings()

        aid = case.account_id.strip().upper()

        if (
            aid not in G
            or G.nodes[aid].get("type")
            != "account"
        ):
            raise HTTPException(
                status_code=404,
                detail=f"Account '{aid}' not found",
            )

        result = analyze_with_settings(
            G,
            aid,
            settings,
        )

        cases = load_cases()

        existing = next(
            (
                item
                for item in cases
                if (
                    isinstance(item, dict)
                    and item.get("account_id")
                    == aid
                    and item.get("status")
                    in {
                        "OPEN",
                        "INVESTIGATING",
                    }
                )
            ),
            None,
        )

        if existing:
            return {
                "success": True,
                "existing": True,
                "message": "An active case already exists for this account.",
                **existing,
            }

        now = utc_now()

        new_case = {
            "case_id": next_case_id(cases),
            "account_id": aid,
            "priority": case.priority,
            "status": "OPEN",
            "risk_score": result["risk_score"],
            "risk_status": result["status"],
            "reasons": result.get(
                "reasons",
                [],
            ),
            "note": case.note.strip(),
            "evidence": [
                {
                    "evidence_id": f"EVD-AUTO-{idx:03d}",
                    "evidence_type": "Graph signal",
                    "description": reason,
                    "timestamp": now,
                }
                for idx, reason in enumerate(
                    result.get(
                        "reasons",
                        [],
                    ),
                    start=1,
                )
            ],
            "timeline": [
                {
                    "event_id": "EVT-0001",
                    "type": "CASE_CREATED",
                    "title": "Case created",
                    "description": (
                        f"Case created from the "
                        f"{aid} graph investigation."
                    ),
                    "timestamp": now,
                }
            ],
            "created_at": now,
            "updated_at": now,
        }

        cases.append(new_case)

        save_cases(cases)

        return {
            "success": True,
            "existing": False,
            "message": "Case created successfully.",
            **new_case,
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.patch("/api/cases/{case_id}")
def update_case(
    case_id: str,
    update: CaseUpdate,
):
    try:
        cases = load_cases()

        target_id = case_id.strip()

        for item in cases:
            if (
                not isinstance(item, dict)
                or item.get("case_id")
                != target_id
            ):
                continue

            old_status = str(
                item.get(
                    "status",
                    "OPEN",
                )
            ).upper()

            if update.status is not None:
                item["status"] = update.status

            if update.note is not None:
                item["note"] = update.note.strip()

            if update.priority is not None:
                item["priority"] = update.priority

            item["updated_at"] = utc_now()

            if item.get("status") != old_status:
                add_timeline_event(
                    item,
                    f"Status changed to {item['status']}",
                    (
                        f"Case moved from "
                        f"{old_status} to "
                        f"{item['status']}."
                    ),
                    "STATUS_CHANGE",
                )

            save_cases(cases)

            return {
                "success": True,
                "message": f"{target_id} updated.",
                **item,
            }

        raise HTTPException(
            status_code=404,
            detail=f"Case '{target_id}' not found",
        )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.post("/api/cases/{case_id}/evidence")
def add_evidence(
    case_id: str,
    evidence: EvidenceCreate,
):
    try:
        cases = load_cases()

        target_id = case_id.strip()

        for item in cases:
            if (
                not isinstance(item, dict)
                or item.get("case_id")
                != target_id
            ):
                continue

            if not isinstance(
                item.get("evidence"),
                list,
            ):
                item["evidence"] = []

            records = item["evidence"]

            record = {
                "evidence_id": (
                    f"EVD-{len(records) + 1:04d}"
                ),
                "evidence_type": evidence.evidence_type,
                "description": evidence.description,
                "timestamp": utc_now(),
            }

            records.append(record)

            add_timeline_event(
                item,
                "Evidence added",
                (
                    f"{evidence.evidence_type}: "
                    f"{evidence.description}"
                ),
                "EVIDENCE",
            )

            item["updated_at"] = utc_now()

            save_cases(cases)

            return {
                "success": True,
                "evidence": record,
                "case": item,
            }

        raise HTTPException(
            status_code=404,
            detail=f"Case '{target_id}' not found",
        )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# INGESTION
# -------------------------------------------------------------------

@app.post("/api/ingest")
def ingest(batch: IngestBatch):
    return {
        "accepted": len(batch.transactions),
        "mode": "validated_batch",
        "streaming_ready": True,
        "transactions": [
            tx.model_dump()
            for tx in batch.transactions
        ],
    }


# -------------------------------------------------------------------
# PROFILE
# -------------------------------------------------------------------

@app.get("/api/profile")
def profile():
    try:
        cases = load_cases()

        return {
            "name": "R. Kulkarni",
            "role": "Fraud Analyst",
            "organization": "FinSentinels",
            "active_cases": sum(
                1
                for c in cases
                if (
                    isinstance(c, dict)
                    and c.get("status")
                    in {
                        "OPEN",
                        "INVESTIGATING",
                    }
                )
            ),
            "total_cases": len(cases),
            "system": "Online",
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# -------------------------------------------------------------------
# SETTINGS
# -------------------------------------------------------------------

@app.get("/api/settings")
def read_settings():
    return get_settings()


@app.put("/api/settings")
def update_settings(payload: SettingsUpdate):
    if payload.watch_threshold >= payload.high_threshold:
        raise HTTPException(
            status_code=400,
            detail=(
                "Watch threshold must be lower "
                "than high-risk threshold"
            ),
        )

    settings = payload.model_dump()

    return save_settings(settings)


# -------------------------------------------------------------------
# STARTUP
# -------------------------------------------------------------------

@app.on_event("startup")
def startup():
    try:
        TMP_DIR.mkdir(
            parents=True,
            exist_ok=True,
        )
    except OSError:
        pass

    print("FinSentinels API online")