import json
import os
from datetime import datetime, timezone
from typing import Any

import networkx as nx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from graph_builder import (
    analyze_account,
    find_data_file,
    get_account_transactions,
    get_full_graph,
    get_subgraph,
    load_graph_data,
    load_transactions,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
CASE_FILE = os.path.join(DATA_DIR, "cases.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

DEFAULT_SETTINGS = {
    "high_threshold": 65,
    "watch_threshold": 35,
    "graph_depth": 2,
}

app = FastAPI(
    title="FinSentinels",
    description="Explainable graph-based financial fraud investigation API",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR),
    name="static",
)


class CaseCreate(BaseModel):
    account_id: str = Field(min_length=1, max_length=100)
    priority: str = Field(default="MEDIUM", max_length=20)
    note: str = Field(default="", max_length=2000)


class CaseUpdate(BaseModel):
    status: str


class EvidenceCreate(BaseModel):
    evidence_type: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=3000)


class SettingsUpdate(BaseModel):
    high_threshold: int = Field(ge=1, le=100)
    watch_threshold: int = Field(ge=0, le=99)
    graph_depth: int = Field(ge=1, le=5)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json_file(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def write_json_file(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = path + ".tmp"

    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(
            data,
            handle,
            indent=2,
            ensure_ascii=False,
        )

    os.replace(temp_path, path)


def get_settings() -> dict[str, int]:
    loaded = read_json_file(
        SETTINGS_FILE,
        DEFAULT_SETTINGS.copy(),
    )

    if not isinstance(loaded, dict):
        loaded = {}

    settings = {
        **DEFAULT_SETTINGS,
        **loaded,
    }

    high = max(
        1,
        min(int(settings["high_threshold"]), 100),
    )

    watch = max(
        0,
        min(int(settings["watch_threshold"]), 99),
    )

    depth = max(
        1,
        min(int(settings["graph_depth"]), 5),
    )

    if watch >= high:
        watch = max(0, high - 1)

    return {
        "high_threshold": high,
        "watch_threshold": watch,
        "graph_depth": depth,
    }


def save_settings(
    settings: dict[str, int],
) -> dict[str, int]:
    clean = {
        "high_threshold": int(
            settings["high_threshold"]
        ),
        "watch_threshold": int(
            settings["watch_threshold"]
        ),
        "graph_depth": int(
            settings["graph_depth"]
        ),
    }

    write_json_file(
        SETTINGS_FILE,
        clean,
    )

    return clean


def load_cases() -> list[dict[str, Any]]:
    data = read_json_file(
        CASE_FILE,
        [],
    )

    return data if isinstance(data, list) else []


def save_cases(
    cases: list[dict[str, Any]],
) -> None:
    write_json_file(
        CASE_FILE,
        cases,
    )


def status_from_score(
    score: int,
    settings: dict[str, int],
) -> str:
    if score >= settings["high_threshold"]:
        return "HIGH RISK"

    if score >= settings["watch_threshold"]:
        return "WATCH"

    return "SAFE"


def analyze_with_settings(
    graph: nx.MultiDiGraph,
    account_id: str,
) -> dict[str, Any]:
    result = analyze_account(
        graph,
        account_id,
    )

    if result.get("status") == "NOT FOUND":
        return result

    result["status"] = status_from_score(
        int(result.get("risk_score", 0)),
        get_settings(),
    )

    return result


def enrich_case(
    case_item: dict[str, Any],
) -> dict[str, Any]:
    enriched = dict(case_item)

    account_id = str(
        case_item.get("account_id", "")
    ).strip().upper()

    if not account_id:
        return enriched

    try:
        graph = load_graph_data()

        analysis = analyze_with_settings(
            graph,
            account_id,
        )

        enriched["risk_score"] = analysis.get(
            "risk_score",
            0,
        )

        enriched["risk_status"] = analysis.get(
            "status",
            "SAFE",
        )

        enriched["reasons"] = analysis.get(
            "reasons",
            [],
        )

        enriched["analysis"] = analysis

        enriched["transactions"] = (
            get_account_transactions(
                graph,
                account_id,
            )
        )

    except Exception as exc:
        print(
            f"[FinSentinels] Case enrichment warning: {exc}"
        )

        enriched.setdefault(
            "analysis",
            {},
        )

        enriched.setdefault(
            "transactions",
            [],
        )

    return enriched


@app.get("/")
def dashboard() -> FileResponse:
    index_path = os.path.join(
        BASE_DIR,
        "index.html",
    )

    if not os.path.isfile(index_path):
        raise HTTPException(
            status_code=500,
            detail=(
                "index.html not found "
                "in backend folder."
            ),
        )

    return FileResponse(index_path)


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        graph = load_graph_data()
        transactions = load_transactions()

        accounts = [
            node
            for node, data in graph.nodes(data=True)
            if data.get("type") == "account"
        ]

        return {
            "status": "healthy",
            "service": "FinSentinels API",
            "nodes": graph.number_of_nodes(),
            "edges": graph.number_of_edges(),
            "accounts": len(accounts),
            "transactions": len(transactions),
            "data_file": os.path.basename(
                find_data_file()
            ),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/data-quality")
def data_quality() -> dict[str, Any]:
    try:
        transactions = load_transactions()

        required = {
            "transaction_id",
            "source_account",
            "target_account",
            "amount",
            "timestamp",
        }

        invalid_rows = []

        for index, tx in enumerate(
            transactions,
            start=1,
        ):
            missing = sorted(
                required - tx.keys()
            )

            if missing:
                invalid_rows.append(
                    {
                        "row": index,
                        "missing": missing,
                    }
                )

        ids = [
            tx.get("transaction_id")
            for tx in transactions
        ]

        return {
            "status": (
                "valid"
                if not invalid_rows
                else "invalid"
            ),
            "transaction_count": len(
                transactions
            ),
            "unique_transaction_ids": len(
                set(ids)
            ),
            "invalid": len(
                invalid_rows
            ),
            "invalid_rows": invalid_rows[:25],
            "data_file": find_data_file(),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/score/{account_id}")
def score(
    account_id: str,
) -> dict[str, Any]:
    try:
        graph = load_graph_data()

        normalized = (
            account_id
            .strip()
            .upper()
        )

        result = analyze_with_settings(
            graph,
            normalized,
        )

        if result.get("status") == "NOT FOUND":
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Account '{normalized}' "
                    "not found."
                ),
            )

        settings = get_settings()

        result["graph"] = get_subgraph(
            graph,
            normalized,
            depth=settings["graph_depth"],
        )

        result["transactions"] = (
            get_account_transactions(
                graph,
                normalized,
            )
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
def graph(
    account_id: str,
) -> dict[str, Any]:
    try:
        graph_data = load_graph_data()

        normalized = (
            account_id
            .strip()
            .upper()
        )

        if (
            normalized not in graph_data
            or graph_data.nodes[
                normalized
            ].get("type")
            != "account"
        ):
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Account '{normalized}' "
                    "not found."
                ),
            )

        return {
            "account_id": normalized,
            "graph": get_subgraph(
                graph_data,
                normalized,
                depth=get_settings()[
                    "graph_depth"
                ],
            ),
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/network")
def network() -> dict[str, Any]:
    try:
        graph_data = load_graph_data()

        return {
            "graph": get_full_graph(
                graph_data
            ),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/alerts")
def alerts() -> dict[str, Any]:
    try:
        graph = load_graph_data()
        items = []

        for (
            account_id,
            node_data,
        ) in graph.nodes(data=True):

            if (
                node_data.get("type")
                != "account"
            ):
                continue

            result = analyze_with_settings(
                graph,
                account_id,
            )

            if result.get("status") not in {
                "HIGH RISK",
                "WATCH",
            }:
                continue

            items.append(
                {
                    "account_id": account_id,
                    "risk_score": result.get(
                        "risk_score",
                        0,
                    ),
                    "status": result.get(
                        "status",
                        "WATCH",
                    ),
                    "reasons": result.get(
                        "reasons",
                        [],
                    ),
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
                }
            )

        items.sort(
            key=lambda item: item[
                "risk_score"
            ],
            reverse=True,
        )

        return {
            "count": len(items),
            "alerts": items,
            "generated_at": utc_now(),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/analytics")
def analytics() -> dict[str, Any]:
    try:
        graph = load_graph_data()
        cases = load_cases()

        accounts = [
            node
            for node, data in graph.nodes(data=True)
            if data.get("type") == "account"
        ]

        devices = [
            node
            for node, data in graph.nodes(data=True)
            if data.get("type") == "device"
        ]

        transfers = [
            data
            for (
                _source,
                _target,
                _key,
                data,
            ) in graph.edges(
                keys=True,
                data=True,
            )
            if data.get(
                "edge_type"
            )
            == "TRANSFER"
        ]

        risk = {
            "high_risk": 0,
            "watch": 0,
            "safe": 0,
        }

        scores = []

        for account_id in accounts:
            result = analyze_with_settings(
                graph,
                account_id,
            )

            score_value = int(
                result.get(
                    "risk_score",
                    0,
                )
            )

            scores.append(
                score_value
            )

            bucket = {
                "HIGH RISK": "high_risk",
                "WATCH": "watch",
                "SAFE": "safe",
            }.get(
                result.get(
                    "status"
                ),
                "safe",
            )

            risk[bucket] += 1

        account_graph = nx.DiGraph()
        account_graph.add_nodes_from(
            accounts
        )

        for (
            source,
            target,
            _key,
            data,
        ) in graph.edges(
            keys=True,
            data=True,
        ):

            if (
                data.get("edge_type")
                == "TRANSFER"
            ):
                account_graph.add_edge(
                    source,
                    target,
                )

        cycles = list(
            nx.simple_cycles(
                account_graph
            )
        )

        shared_devices = []

        for device in devices:

            users = {
                source
                for (
                    source,
                    _target,
                    _key,
                    edge,
                ) in graph.in_edges(
                    device,
                    keys=True,
                    data=True,
                )
                if (
                    edge.get(
                        "edge_type"
                    )
                    == "USED_DEVICE"
                    and graph.nodes[
                        source
                    ].get("type")
                    == "account"
                )
            }

            if len(users) > 1:
                shared_devices.append(
                    {
                        "device_id": device,
                        "accounts": sorted(
                            users
                        ),
                        "account_count": len(
                            users
                        ),
                    }
                )

        total_volume = sum(
            float(
                tx.get(
                    "amount",
                    0,
                )
            )
            for tx in transfers
        )

        open_cases = sum(
            1
            for case in cases
            if str(
                case.get(
                    "status",
                    "",
                )
            ).upper()
            in {
                "OPEN",
                "INVESTIGATING",
            }
        )

        investigating_cases = sum(
            1
            for case in cases
            if str(
                case.get(
                    "status",
                    "",
                )
            ).upper()
            == "INVESTIGATING"
        )

        closed_cases = sum(
            1
            for case in cases
            if str(
                case.get(
                    "status",
                    "",
                )
            ).upper()
            == "CLOSED"
        )

        dismissed_cases = sum(
            1
            for case in cases
            if str(
                case.get(
                    "status",
                    "",
                )
            ).upper()
            == "DISMISSED"
        )

        return {
            "generated_at": utc_now(),
            "network": {
                "accounts": len(
                    accounts
                ),
                "devices": len(
                    devices
                ),
                "transactions": len(
                    transfers
                ),
                "connections": graph.number_of_edges(),
                "nodes": graph.number_of_nodes(),
            },
            "risk_distribution": risk,
            "fraud_patterns": {
                "active_cycles": len(
                    cycles
                ),
                "shared_devices": len(
                    shared_devices
                ),
            },
            "transaction_metrics": {
                "total_volume": round(
                    total_volume,
                    2,
                ),
                "average_transaction": (
                    round(
                        total_volume
                        / len(
                            transfers
                        ),
                        2,
                    )
                    if transfers
                    else 0
                ),
            },
            "average_risk_score": (
                round(
                    sum(scores)
                    / len(scores),
                    2,
                )
                if scores
                else 0
            ),
            "shared_device_details": (
                shared_devices
            ),
            "case_metrics": {
                "total": len(cases),
                "open": open_cases,
                "investigating": investigating_cases,
                "closed": closed_cases,
                "dismissed": dismissed_cases,
            },
            "settings": get_settings(),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/cases")
def get_cases() -> dict[str, Any]:
    try:
        cases = [
            enrich_case(case)
            for case in load_cases()
        ]

        cases.sort(
            key=lambda item: item.get(
                "created_at",
                "",
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


@app.post("/api/cases")
def create_case(
    case: CaseCreate,
) -> dict[str, Any]:

    try:
        graph = load_graph_data()

        account_id = (
            case.account_id
            .strip()
            .upper()
        )

        if (
            account_id not in graph
            or graph.nodes[
                account_id
            ].get("type")
            != "account"
        ):
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Account '{account_id}' "
                    "not found."
                ),
            )

        analysis = analyze_with_settings(
            graph,
            account_id,
        )

        cases = load_cases()

        existing = next(
            (
                item
                for item in cases
                if (
                    str(
                        item.get(
                            "account_id",
                            "",
                        )
                    ).upper()
                    == account_id
                    and str(
                        item.get(
                            "status",
                            "",
                        )
                    ).upper()
                    in {
                        "OPEN",
                        "INVESTIGATING",
                    }
                )
            ),
            None,
        )

        if existing:
            return enrich_case(
                existing
            )

        numbers = []

        for item in cases:
            raw_id = str(
                item.get(
                    "case_id",
                    "",
                )
            )

            if raw_id.startswith(
                "CASE-"
            ):
                try:
                    numbers.append(
                        int(
                            raw_id.split(
                                "-",
                                1,
                            )[1]
                        )
                    )
                except ValueError:
                    pass

        next_number = (
            max(numbers, default=0)
            + 1
        )

        now = utc_now()

        new_case = {
            "case_id": (
                f"CASE-{next_number:04d}"
            ),
            "account_id": account_id,
            "priority": (
                case.priority
                .strip()
                .upper()
                or "MEDIUM"
            ),
            "status": "OPEN",
            "risk_score": int(
                analysis.get(
                    "risk_score",
                    0,
                )
            ),
            "risk_status": analysis.get(
                "status",
                "SAFE",
            ),
            "reasons": analysis.get(
                "reasons",
                [],
            ),
            "note": case.note.strip(),
            "created_at": now,
            "updated_at": now,
            "evidence": [],
            "timeline": [
                {
                    "title": "Case created",
                    "description": (
                        f"Case opened for {account_id} "
                        "from the FinSentinels "
                        "investigation workspace."
                    ),
                    "timestamp": now,
                }
            ],
        }

        cases.append(
            new_case
        )

        save_cases(
            cases
        )

        return enrich_case(
            new_case
        )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/cases/{case_id}")
def get_case(
    case_id: str,
) -> dict[str, Any]:

    normalized = case_id.strip()

    for case in load_cases():

        if (
            str(
                case.get(
                    "case_id",
                    "",
                )
            )
            == normalized
        ):
            return enrich_case(
                case
            )

    raise HTTPException(
        status_code=404,
        detail=(
            f"Case '{normalized}' "
            "not found."
        ),
    )


@app.patch("/api/cases/{case_id}")
def update_case(
    case_id: str,
    update: CaseUpdate,
) -> dict[str, Any]:

    allowed = {
        "OPEN",
        "INVESTIGATING",
        "CLOSED",
        "DISMISSED",
    }

    status = (
        update.status
        .strip()
        .upper()
    )

    if status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=(
                "Status must be one of: "
                "OPEN, INVESTIGATING, "
                "CLOSED, DISMISSED"
            ),
        )

    cases = load_cases()

    for item in cases:

        if (
            str(
                item.get(
                    "case_id",
                    "",
                )
            )
            != case_id
        ):
            continue

        old_status = str(
            item.get(
                "status",
                "OPEN",
            )
        ).upper()

        now = utc_now()

        item["status"] = status
        item["updated_at"] = now

        item.setdefault(
            "timeline",
            [],
        ).append(
            {
                "title": "Case status updated",
                "description": (
                    f"Status changed from "
                    f"{old_status} to {status}."
                ),
                "timestamp": now,
            }
        )

        save_cases(
            cases
        )

        return enrich_case(
            item
        )

    raise HTTPException(
        status_code=404,
        detail=(
            f"Case '{case_id}' "
            "not found."
        ),
    )


@app.post(
    "/api/cases/{case_id}/evidence"
)
def add_evidence(
    case_id: str,
    evidence: EvidenceCreate,
) -> dict[str, Any]:

    cases = load_cases()

    for item in cases:

        if (
            str(
                item.get(
                    "case_id",
                    "",
                )
            )
            != case_id
        ):
            continue

        now = utc_now()

        evidence_item = {
            "evidence_id": (
                "EVD-"
                + datetime.now(
                    timezone.utc
                ).strftime(
                    "%Y%m%d%H%M%S%f"
                )
            ),
            "evidence_type": (
                evidence.evidence_type
                .strip()
            ),
            "description": (
                evidence.description
                .strip()
            ),
            "timestamp": now,
        }

        item.setdefault(
            "evidence",
            [],
        ).append(
            evidence_item
        )

        item.setdefault(
            "timeline",
            [],
        ).append(
            {
                "title": "Evidence added",
                "description": (
                    evidence.description
                    .strip()
                ),
                "timestamp": now,
            }
        )

        item["updated_at"] = now

        save_cases(
            cases
        )

        return enrich_case(
            item
        )

    raise HTTPException(
        status_code=404,
        detail=(
            f"Case '{case_id}' "
            "not found."
        ),
    )


@app.get("/api/profile")
def profile() -> dict[str, Any]:

    cases = load_cases()

    active = sum(
        1
        for case in cases
        if str(
            case.get(
                "status",
                "",
            )
        ).upper()
        in {
            "OPEN",
            "INVESTIGATING",
        }
    )

    return {
        "name": "R. Kulkarni",
        "role": "Fraud Analyst",
        "organization": "FinSentinels",
        "active_cases": active,
        "total_cases": len(cases),
        "system": "Online",
    }


@app.get("/api/settings")
def read_settings() -> dict[str, int]:
    return get_settings()


@app.put("/api/settings")
def update_settings(
    payload: SettingsUpdate,
) -> dict[str, int]:

    if (
        payload.watch_threshold
        >= payload.high_threshold
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Watch threshold must be "
                "lower than high-risk "
                "threshold."
            ),
        )

    return save_settings(
        payload.model_dump()
    )


@app.on_event("startup")
def startup() -> None:

    os.makedirs(
        DATA_DIR,
        exist_ok=True,
    )

    os.makedirs(
        STATIC_DIR,
        exist_ok=True,
    )

    if not os.path.isfile(
        SETTINGS_FILE
    ):
        save_settings(
            DEFAULT_SETTINGS.copy()
        )

    if not os.path.isfile(
        CASE_FILE
    ):
        save_cases(
            []
        )

    print(
        "FinSentinels API online"
    )