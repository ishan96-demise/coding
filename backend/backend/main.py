import json
import hashlib
import logging
import os
import re
import tempfile
import asyncio
import hmac
import uuid
import csv
import io
from datetime import date, timedelta
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse

import networkx as nx
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator
from obp_integration import OBPError, normalize_event as normalize_obp_event, status as obp_status, sync_transactions as sync_obp_transactions, verify_webhook_signature
from portal_store import (
    PortalRateLimitError,
    SESSION_COOKIE_NAME as CUSTOMER_SESSION_COOKIE,
    SESSION_TTL_SECONDS as CUSTOMER_SESSION_TTL,
    change_customer_password as portal_change_customer_password,
    customer_accounts as portal_customer_accounts,
    customer_intelligence as portal_customer_intelligence,
    customer_for_session as portal_customer_for_session,
    get_customer_transaction as portal_get_customer_transaction,
    initialize_portal_store,
    list_customer_transactions as portal_list_customer_transactions,
    login_customer as portal_login_customer,
    logout_customer as portal_logout_customer,
    record_audit as portal_record_audit,
    record_reported_case as portal_record_reported_case,
    reported_case as portal_reported_case,
    reported_cases as portal_reported_cases,
    signup_customer as portal_signup_customer,
    update_customer_name as portal_update_customer_name,
)


def _load_local_backend_environment() -> None:
    """Load ignored local secrets without requiring python-dotenv."""
    env_file = Path(__file__).resolve().parent / "backend.local.env"
    try:
        lines = env_file.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key, value = key.strip(), value.strip()
        if key and value:
            os.environ.setdefault(key, value.strip('"').strip("'"))


_load_local_backend_environment()

from graph_builder import (
    DATA_MODE,
    analyze_account,
    find_data_files,
    get_account_transactions,
    get_alert_subgraph,
    get_full_graph,
    get_subgraph,
    invalidate_cache,
    load_graph_data,
    load_transactions,
    load_synthetic_transactions,
    LIVE_FILE,
)

# Import PyTorch only after the API is serving. Its Windows import and model
# warm-up can take long enough to make the entire backend look offline.
GNN_IMPORT_ERROR: str | None = None
GNN_ENGINE = None
GNN_TRANSACTIONS: list[dict[str, Any]] = []
GNN_TRAINING_TASK: asyncio.Task | None = None

# ============================================================
# PATHS
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"

INDEX_FILE = BASE_DIR / "index.html"
APP_JS_FILE = BASE_DIR / "app.js"

SETTINGS_FILENAME = "settings.json"
CASE_FILENAME = "cases.json"

_runtime_data_dir = os.getenv("FINSENTINELS_RUNTIME_DIR", "").strip()
_default_runtime_data_dir = BASE_DIR / "runtime-data" if DATA_MODE == "production" else DATA_DIR
RUNTIME_DATA_DIR = Path(_runtime_data_dir).expanduser() if _runtime_data_dir else _default_runtime_data_dir

CASE_FILE = RUNTIME_DATA_DIR / CASE_FILENAME
CASE_EVIDENCE_DIR = RUNTIME_DATA_DIR / "case_evidence"
SETTINGS_FILE = RUNTIME_DATA_DIR / SETTINGS_FILENAME

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

# Keeps runtime changes available for the current process.
IN_MEMORY_STORAGE: dict[str, Any] = {}


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="FinSentinels",
    description=(
        "Explainable graph-based financial fraud network "
        "detection and investigation API"
    ),
    version="3.0.0",
)
logger = logging.getLogger("finsentinels.api")


@app.exception_handler(HTTPException)
async def sanitize_server_error(request: Request, exc: HTTPException):
    """Keep internal exception details in server logs, never in client responses."""
    if exc.status_code in {500, 502}:
        cause = exc.__cause__
        if cause is not None:
            logger.error(
                "Internal API error for %s",
                request.url.path,
                exc_info=(type(cause), cause, cause.__traceback__),
            )
        else:
            logger.error("Internal API error for %s", request.url.path)
        return JSONResponse(
            {"detail": "The request could not be completed. Please try again."},
            status_code=exc.status_code,
            headers=exc.headers,
        )

    return JSONResponse(
        jsonable_encoder({"detail": exc.detail}),
        status_code=exc.status_code,
        headers=exc.headers,
    )


@app.middleware("http")
async def require_authenticated_frontend_proxy(request: Request, call_next):
    """Keep API data behind Next.js analyst auth; only signed OBP callbacks bypass it."""
    if request.url.path.lower().endswith((".bak", ".log", ".env")):
        return JSONResponse({"detail": "Not found."}, status_code=404)
    if request.url.path.startswith("/api/") and request.url.path != "/api/integrations/obp/webhook":
        expected = os.getenv("FIN_SENTINELS_BACKEND_API_KEY", "")
        provided = request.headers.get("x-fin-sentinels-backend-key", "")
        if len(expected) < 32:
            return JSONResponse({"detail": "The application API is not configured."}, status_code=503)
        if not hmac.compare_digest(expected, provided):
            return JSONResponse({"detail": "Authentication required."}, status_code=401)
    return await call_next(request)

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)
if STATIC_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(
            directory=str(STATIC_DIR),
            html=False,
        ),
        name="static",
    )


# ============================================================
# REQUEST MODELS
# ============================================================

class CaseCreate(BaseModel):
    account_id: str = Field(
        min_length=1,
        max_length=100,
    )

    priority: str = "HIGH"

    note: str = Field(
        default="",
        max_length=5000,
    )

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
                "Priority must be one of: "
                f"{', '.join(sorted(ALLOWED_PRIORITIES))}"
            )

        return value


class PortalSignupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=10, max_length=128)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Enter your name.")
        return value

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Enter a valid email address.")
        return value


class PortalLoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Enter a valid email address.")
        return value


class PortalReportRequest(BaseModel):
    message: str = Field(default="", max_length=1200)


class PortalProfileRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Enter your name.")
        return value


class PortalPasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


class CaseUpdate(BaseModel):
    status: str | None = None

    note: str | None = Field(
        default=None,
        max_length=5000,
    )

    priority: str | None = None

    @field_validator("status")
    @classmethod
    def validate_status(
        cls,
        value: str | None,
    ) -> str | None:
        if value is None:
            return None

        value = value.strip().upper()

        if value not in ALLOWED_CASE_STATUSES:
            raise ValueError(
                "Status must be one of: "
                f"{', '.join(sorted(ALLOWED_CASE_STATUSES))}"
            )

        return value

    @field_validator("priority")
    @classmethod
    def validate_priority(
        cls,
        value: str | None,
    ) -> str | None:
        if value is None:
            return None

        value = value.strip().upper()

        if value not in ALLOWED_PRIORITIES:
            raise ValueError(
                "Priority must be one of: "
                f"{', '.join(sorted(ALLOWED_PRIORITIES))}"
            )

        return value


class EvidenceCreate(BaseModel):
    evidence_type: str = Field(
        min_length=1,
        max_length=120,
    )

    description: str = Field(
        default="",
        max_length=5000,
    )

    transaction_ids: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    @field_validator("evidence_type")
    @classmethod
    def trim_evidence_type(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Evidence type cannot be empty")
        return value

    @field_validator("description")
    @classmethod
    def trim_description(cls, value: str) -> str:
        return value.strip()

    @field_validator("transaction_ids")
    @classmethod
    def normalize_transaction_ids(cls, values: list[str]) -> list[str]:
        normalized = []
        seen = set()
        for value in values:
            transaction_id = value.strip()
            if not transaction_id:
                continue
            if len(transaction_id) > 120:
                raise ValueError("Transaction IDs must be at most 120 characters")
            if transaction_id not in seen:
                normalized.append(transaction_id)
                seen.add(transaction_id)
        return normalized

    @model_validator(mode="after")
    def require_description_or_transaction(self):
        if not self.description and not self.transaction_ids:
            raise ValueError("Add evidence details or at least one transaction ID")
        return self


class SettingsUpdate(BaseModel):
    high_threshold: int = Field(
        ge=1,
        le=100,
    )

    watch_threshold: int = Field(
        ge=0,
        le=99,
    )

    graph_depth: int = Field(
        ge=1,
        le=5,
    )


class IngestTransaction(BaseModel):
    transaction_id: str = Field(
        min_length=1,
        max_length=120,
    )

    source_account: str = Field(
        min_length=1,
        max_length=100,
    )

    target_account: str = Field(
        min_length=1,
        max_length=100,
    )

    source_name: str | None = None

    target_name: str | None = None

    amount: float = Field(
        gt=0,
    )

    currency: str = Field(default="INR", min_length=3, max_length=3)

    amount_inr: float | None = Field(default=None, ge=0)

    fx_reference_rate: float | None = Field(default=None, gt=0)

    fx_rate_as_of: str | None = Field(default=None, max_length=80)

    fx_rate_source: str | None = Field(default=None, max_length=100)

    instructed_amount: float | None = Field(default=None, ge=0)

    instructed_currency: str | None = Field(default=None, min_length=3, max_length=3)

    fx_divergence_ratio: float | None = Field(default=None, ge=0)

    currency_mismatch: bool = False

    fx_unconverted: bool = False

    direction: str | None = Field(default=None, max_length=20)

    source_provider: str | None = Field(default=None, max_length=80)

    source_event_id: str | None = Field(default=None, max_length=120)

    timestamp: str

    device_id: str | None = None

    ip_address: str | None = None

    merchant_id: str | None = None

    location: str | None = None

    location_country: str | None = None

    source_country: str | None = None

    target_country: str | None = None

    @field_validator("timestamp")
    @classmethod
    def validate_timestamp(cls, value: str) -> str:
        value = value.strip()
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("timestamp must be an ISO-8601 date-time") from exc
        return value

    @field_validator("currency", "instructed_currency")
    @classmethod
    def validate_currency_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", value):
            raise ValueError("currency must be a three-letter ISO code")
        return value


class IngestBatch(BaseModel):
    transactions: list[IngestTransaction] = Field(
        min_length=1,
        max_length=5000,
    )


class AgentWidget(BaseModel):
    event_id: str
    agent: str
    widget_type: str
    subject: str
    score: int
    risk_level: str
    confidence: float | None = None
    confidence_label: str = "Not calibrated"
    rationale: str
    evidence: list[str] = Field(default_factory=list)
    score_components: dict[str, dict[str, float | int | bool]] = Field(default_factory=dict)
    timestamp: str


# ============================================================
# HELPERS
# ============================================================

def utc_now() -> str:
    return datetime.now(
        timezone.utc
    ).isoformat()


def read_json_file(
    filename: str,
    default: Any,
) -> Any:
    """
    Read runtime state first, then fall back to bundled seed data.
    """

    if filename in IN_MEMORY_STORAGE:
        return IN_MEMORY_STORAGE[filename]

    runtime_path = RUNTIME_DATA_DIR / filename
    bundled_path = DATA_DIR / filename

    # Demo seed state is only a local-development fallback. Production must
    # never resurrect bundled cases or settings from the image.
    candidate_paths = [runtime_path]
    if DATA_MODE == "demo":
        candidate_paths.append(bundled_path)

    for path in candidate_paths:
        if not path.exists():
            continue

        try:
            with path.open(
                "r",
                encoding="utf-8",
            ) as handle:
                data = json.load(handle)

            IN_MEMORY_STORAGE[filename] = data

            return data

        except (
            json.JSONDecodeError,
            OSError,
        ):
            continue

    IN_MEMORY_STORAGE[filename] = default

    return default


def write_json_file(
    filename: str,
    data: Any,
) -> None:
    """
    Atomically save runtime state and fail loudly if durable storage is down.
    """

    target = (
        RUNTIME_DATA_DIR / filename
    )

    try:
        target.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        temp = target.with_suffix(
            target.suffix + ".tmp"
        )

        with FILE_LOCK:
            with temp.open(
                "w",
                encoding="utf-8",
            ) as handle:
                json.dump(
                    data,
                    handle,
                    indent=2,
                    ensure_ascii=False,
                )

            os.replace(
                temp,
                target,
            )

    except OSError as exc:
        # A failed write must not look successful or remain visible from the
        # process cache after the caller receives an error.
        IN_MEMORY_STORAGE.pop(filename, None)
        raise RuntimeError(
            "Persistent application storage is unavailable; no changes were saved."
        ) from exc

    IN_MEMORY_STORAGE[filename] = data


def get_settings() -> dict[str, Any]:
    saved = read_json_file(
        SETTINGS_FILENAME,
        {},
    )

    if not isinstance(saved, dict):
        saved = {}

    settings = {
        **DEFAULT_SETTINGS,
        **saved,
    }

    settings["high_threshold"] = int(
        settings.get(
            "high_threshold",
            DEFAULT_SETTINGS["high_threshold"],
        )
    )

    settings["watch_threshold"] = int(
        settings.get(
            "watch_threshold",
            DEFAULT_SETTINGS["watch_threshold"],
        )
    )

    settings["graph_depth"] = int(
        settings.get(
            "graph_depth",
            DEFAULT_SETTINGS["graph_depth"],
        )
    )

    if (
        settings["watch_threshold"]
        >= settings["high_threshold"]
    ):
        settings["watch_threshold"] = max(
            0,
            settings["high_threshold"] - 1,
        )

    return settings


def save_settings(
    settings: dict[str, Any],
) -> dict[str, Any]:
    write_json_file(
        SETTINGS_FILENAME,
        settings,
    )

    return settings


def load_cases() -> list[dict[str, Any]]:
    data = read_json_file(
        CASE_FILENAME,
        [],
    )

    if not isinstance(data, list):
        return []

    return data


def save_cases(
    cases: list[dict[str, Any]],
) -> None:
    write_json_file(
        CASE_FILENAME,
        cases,
    )


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

    # Provide a stable network-level assessment alongside the account signal.
    # The cohort is formed from direct counterparties and accounts sharing
    # observed device/IP infrastructure, then explained from graph evidence.
    aid = account_id.strip().upper()
    cohort = {aid}
    for u, v, data in G.edges(data=True):
        if data.get("edge_type") == "TRANSFER" and (u == aid or v == aid):
            other = v if u == aid else u
            if G.nodes.get(other, {}).get("type") == "account":
                cohort.add(other)
    for node, details in G.nodes(data=True):
        if details.get("type") not in {"device", "ip_address"}:
            continue
        linked = {u for u, _v, _k, e in G.in_edges(node, keys=True, data=True)
                  if e.get("edge_type") in {"USED_DEVICE", "USED_IP"}}
        if aid in linked:
            cohort.update(linked)
    account_score = int(result.get("risk_score", 0))
    rule_score = account_score
    member_scores = [(aid, account_score)]
    for member in sorted(cohort - {aid}):
        member_result = analyze_account(G, member)
        member_scores.append((member, int(member_result.get("risk_score", 0))))
    shared_ip = [node for node, d in G.nodes(data=True) if d.get("type") == "ip_address"
                 and G.has_edge(aid, node)
                 and len([u for u, _v, _k, e in G.in_edges(node, keys=True, data=True)
                          if e.get("edge_type") == "USED_IP"]) > 1]
    shared_device_count = len(result.get("shared_devices", []))
    network_reasons = []
    cross_border = []
    observed_countries: set[str] = set()
    observed_locations: set[str] = set()
    country_routes: set[str] = set()
    for u, v, edge in G.edges(data=True):
        if edge.get("edge_type") != "TRANSFER" or (u not in cohort and v not in cohort):
            continue
        source_country, target_country = edge.get("source_country"), edge.get("target_country")
        location_country = edge.get("location_country")
        location = edge.get("location")
        if source_country:
            observed_countries.add(source_country.strip())
        if target_country:
            observed_countries.add(target_country.strip())
        if location_country:
            observed_countries.add(location_country.strip())
        if location:
            observed_locations.add(location.strip())
        if source_country and target_country:
            country_routes.add(f"{source_country.strip()} → {target_country.strip()}")
        if source_country and target_country and source_country.casefold() != target_country.casefold():
            cross_border.append((u, v, source_country, target_country))
    if len(cohort) > 1:
        network_reasons.append(f"The observed transaction network contains {len(cohort)} linked accounts")
    if shared_device_count:
        network_reasons.append(f"{shared_device_count} shared device link(s) connect this network")
    if shared_ip:
        network_reasons.append(f"{len(shared_ip)} shared IP address(es) connect this network")
    if cross_border:
        routes = sorted({f"{source} → {target}" for _u, _v, source, target in cross_border})
        network_reasons.append(f"Cross-border transfers observed: {', '.join(routes)}")
    if result.get("cycle_count"):
        network_reasons.append(f"Circular fund movement links {len(cohort)} account(s) in the network")
    if not network_reasons:
        network_reasons.append("No coordinated device, IP, or circular-flow pattern is currently linked")
    risk_leader, member_base = max(member_scores, key=lambda item: item[1])
    network_reasons.append(
        f"Strongest account signal in the linked cohort is {member_base}/100 on {risk_leader}"
    )
    coordinated_signal = bool(shared_device_count or shared_ip or result.get("cycle_count") or cross_border)
    cohort_bonus = min(8 * max(0, len(cohort) - 1), 24) if coordinated_signal else 0
    shared_ip_bonus = 8 if shared_ip else 0
    cross_border_bonus = 5 if cross_border else 0
    network_score = min(99, member_base + cohort_bonus + shared_ip_bonus + cross_border_bonus)
    rule_network_score = network_score
    hybrid_account_score = rule_score
    hybrid_network_score: int | None = None
    result["account_risk_score"] = account_score
    result["network_risk_score"] = network_score
    result["network_status"] = status_from_score(network_score, settings)
    result["network"] = {"account_count": len(cohort), "account_ids": sorted(cohort),
                         "shared_ip_count": len(shared_ip),
                         "cross_border_transfer_count": len(cross_border),
                         "risk_leader": risk_leader,
                         "observed_countries": sorted(observed_countries),
                         "observed_locations": sorted(observed_locations),
                         "observed_routes": sorted({f"{source} → {target}" for _u, _v, source, target in cross_border}),
                         "country_routes": sorted(country_routes),
                         "score_components": {"highest_linked_account_signal": member_base,
                             "linked_network_bonus": cohort_bonus,
                             "coordinated_signal_present": coordinated_signal,
                             "shared_ip_bonus": shared_ip_bonus,
                             "cross_border_context_bonus": cross_border_bonus},
                         "explanation": network_reasons}
    result["risk_score"] = network_score
    result["reasons"] = list(dict.fromkeys(network_reasons + result.get("reasons", [])))
    result["risk_explanation"] = (
        f"Network risk is {result['network_status'].lower()} at {network_score}/100 because "
        + "; ".join(network_reasons) + "."
    )

    result["rule_risk_score"] = rule_score
    result["gnn"] = {
        "available": False,
        "score": None,
        "confidence": 0.0,
        "evidence": [],
        "model": "GraphSAGE-style unsupervised graph anomaly encoder",
    }
    result["score_components"] = {
        "rules_weight": 1.0,
        "gnn_weight": 0.0,
        "rule_score": rule_score,
        "gnn_score": 0,
        "rule_contribution": rule_score,
        "gnn_contribution": 0,
        "network_adjustments": cohort_bonus + shared_ip_bonus + cross_border_bonus,
        "network_score": network_score,
    }

    if GNN_ENGINE is not None and getattr(GNN_ENGINE, "trained", False):
        try:
            gnn_result = GNN_ENGINE.score_account(
                account_id, transactions=GNN_TRANSACTIONS or None
            )
            if not gnn_result.available:
                result["gnn"].update({
                    "error": gnn_result.evidence[0] if gnn_result.evidence else "GNN inference unavailable.",
                    "evidence": gnn_result.evidence,
                })
            else:
                result["gnn"] = {
                    "available": True,
                    "score": gnn_result.score,
                    "confidence": round(gnn_result.confidence, 4),
                    "confidence_label": "Uncalibrated anomaly evidence strength",
                    "confidence_basis": "1 - exp(-max(z_score, 0) / 2), where z_score is the normalized distance from the normal-reference embedding mean.",
                    "confidence_is_probability": False,
                    "embedding_norm": round(gnn_result.embedding_norm, 4),
                    "evidence": gnn_result.evidence,
                    "feature_deviations": gnn_result.feature_deviations,
                    "model": "GraphSAGE-style unsupervised graph anomaly encoder",
                }
                # Keep the rule engine dominant and the GNN as a secondary signal.
                # This is a ranking score, not a calibrated fraud probability.
                hybrid_score = round(0.80 * rule_score + 0.20 * gnn_result.score)
                hybrid_account_score = hybrid_score
                hybrid_network_score = min(99, hybrid_score + cohort_bonus + shared_ip_bonus + cross_border_bonus)
                network_score = max(rule_network_score, hybrid_network_score)
                result["network_risk_score"] = network_score
                result["network_status"] = status_from_score(network_score, settings)
                result["risk_score"] = network_score
                result["account_risk_score"] = hybrid_score
                network_reasons.append(
                    f"GNN anomaly rank {gnn_result.score}/100 against the normal-only graph baseline"
                )
                if gnn_result.score >= 40:
                    result["reasons"].append(
                        f"GNN structural anomaly signal: {gnn_result.score}/100"
                    )
                result["score_components"] = {
                    "rules_weight": 0.80,
                    "gnn_weight": 0.20,
                    "rule_score": rule_score,
                    "gnn_score": gnn_result.score,
                    "rule_contribution": round(rule_score * 0.80, 2),
                    "gnn_contribution": round(gnn_result.score * 0.20, 2),
                    "network_adjustments": cohort_bonus + shared_ip_bonus + cross_border_bonus,
                    "network_score": network_score,
                }
        except Exception as exc:  # keep the existing scoring path resilient
            logger.warning(
                "GNN inference failed for account %s",
                account_id,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            result["gnn"]["error"] = "GNN inference failed; rule-based evidence remains active."
    elif GNN_IMPORT_ERROR:
        result["gnn"]["error"] = GNN_IMPORT_ERROR
    else:
        result["gnn"]["error"] = "GNN model is not trained; rule-based scoring remains active."

    result["status"] = status_from_score(result.get("risk_score", 0), settings)
    result["network_status"] = result["status"]
    result["risk_explanation"] = (
        f"Network risk is {result['status'].lower()} at {result['risk_score']}/100 because "
        + "; ".join(network_reasons) + "."
    )
    factor_labels = {
        "circular_routing": "Circular fund routing",
        "shared_devices": "Shared device exposure",
        "transaction_velocity": "Transaction velocity",
        "network_connectivity": "Network connectivity",
        "network_centrality": "Network centrality",
        "mule_flow": "Mule flow pattern",
        "high_value_activity": "High-value activity",
    }
    factor_points = result.get("factor_points", {})
    account_drivers = [
        {"factor": factor_labels.get(key, key.replace("_", " ").title()), "points": int(points)}
        for key, points in factor_points.items()
        if isinstance(points, (int, float)) and points > 0
    ]
    account_drivers.sort(key=lambda item: item["points"], reverse=True)
    uses_gnn_basis = hybrid_network_score is not None and hybrid_network_score > rule_network_score
    score_math = {
        "base_label": "GNN-blended focused account score" if uses_gnn_basis else "Strongest linked account signal",
        "base_account_id": aid if uses_gnn_basis else risk_leader,
        "base_score": hybrid_account_score if uses_gnn_basis else member_base,
        "network_uplift": cohort_bonus + shared_ip_bonus + cross_border_bonus,
        "network_score": network_score,
        "rule_network_score": rule_network_score,
        "gnn_blended_network_score": hybrid_network_score,
        "capped_at": 99,
    }
    result["explanation"] = {
        "score_type": "Network risk index",
        "is_probability": False,
        "method": (
            "80% graph rule score + 20% GNN anomaly rank, adjusted for linked network evidence."
            if result["gnn"].get("available")
            else "Graph behavior rules and linked network evidence; GNN is unavailable for this run."
        ),
        "summary": result["risk_explanation"],
        "risk_leader": risk_leader,
        "account_drivers": account_drivers,
        "network_adjustments": result["network"]["score_components"],
        "score_math": score_math,
        "model": result["gnn"],
    }
    return result


def next_case_id(
    cases: list[dict[str, Any]],
) -> str:
    highest = 0

    for case in cases:
        if not isinstance(
            case,
            dict,
        ):
            continue

        value = str(
            case.get(
                "case_id",
                "",
            )
        )

        if not value.startswith("CASE-"):
            continue

        try:
            number = int(
                value.split(
                    "-",
                    1,
                )[1]
            )

            highest = max(
                highest,
                number,
            )

        except (
            IndexError,
            ValueError,
        ):
            pass

    return f"CASE-{highest + 1:04d}"


def add_timeline_event(
    case: dict[str, Any],
    title: str,
    description: str,
    event_type: str = "CASE_EVENT",
) -> None:
    events = case.setdefault(
        "timeline",
        [],
    )

    events.append(
        {
            "event_id": (
                f"EVT-{len(events) + 1:04d}"
            ),
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
    events = list(
        case.get("timeline") or []
    )

    if not events:
        events.append(
            {
                "event_id": "EVT-0001",
                "type": "CASE_CREATED",
                "title": "Case created",
                "description": (
                    f"Investigation opened "
                    f"for {account_id}."
                ),
                "timestamp": (
                    case.get("created_at")
                    or utc_now()
                ),
            }
        )

    return sorted(
        events,
        key=lambda x: x.get(
            "timestamp",
            "",
        ),
    )


# ============================================================
# FRONTEND
# ============================================================

def _portal_cookie_secure(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    return request.url.scheme == "https" or forwarded_proto == "https" or os.getenv("FIN_SENTINELS_COOKIE_SECURE", "").lower() == "true"


def _set_portal_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=CUSTOMER_SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=_portal_cookie_secure(request),
        samesite="lax",
        path="/",
        max_age=CUSTOMER_SESSION_TTL,
    )


def _check_portal_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        if request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
            raise HTTPException(status_code=403, detail="A same-site request origin is required.")
        return
    parsed = urlparse(origin)
    normalized = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    configured = os.getenv("FIN_SENTINELS_FRONTEND_URL", "http://127.0.0.1:3000/").strip()
    configured_url = urlparse(configured)
    allowed = {f"{configured_url.scheme}://{configured_url.netloc}".rstrip("/")}
    if DATA_MODE == "demo":
        allowed.update({"http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001"})
    if normalized not in allowed:
        raise HTTPException(status_code=403, detail="This request origin is not allowed.")


def _require_portal_customer(request: Request) -> dict[str, Any]:
    customer = portal_customer_for_session(request.cookies.get(CUSTOMER_SESSION_COOKIE))
    if not customer:
        raise HTTPException(status_code=401, detail="Your customer session is missing or expired. Please sign in again.")
    return customer


def _portal_filters(request: Request) -> dict[str, Any]:
    params = request.query_params
    start_value = params.get("from")
    end_value = params.get("to")

    def parse_date_bound(value: str | None, *, end: bool = False) -> str | None:
        if not value:
            return None
        try:
            if len(value) == 10:
                parsed_date = date.fromisoformat(value)
                if end:
                    parsed_date += timedelta(days=1)
                parsed = datetime.combine(parsed_date, datetime.min.time(), tzinfo=timezone.utc)
            else:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                else:
                    parsed = parsed.astimezone(timezone.utc)
                if end:
                    parsed += timedelta(seconds=1)
            return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Dates must use YYYY-MM-DD or ISO timestamp format.") from exc

    def parse_amount(name: str) -> float | None:
        raw = params.get(name)
        if raw is None or raw == "":
            return None
        try:
            value = float(raw)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"{name.replace('_', ' ').title()} must be a number.") from exc
        if value < 0:
            raise HTTPException(status_code=422, detail=f"{name.replace('_', ' ').title()} cannot be negative.")
        return value

    minimum = parse_amount("min_amount")
    maximum = parse_amount("max_amount")
    if minimum is not None and maximum is not None and minimum > maximum:
        raise HTTPException(status_code=422, detail="Minimum amount must be less than maximum amount.")

    direction = params.get("direction", "all").lower()
    if direction not in {"all", "incoming", "outgoing"}:
        raise HTTPException(status_code=422, detail="Direction must be all, incoming, or outgoing.")
    status_filter = params.get("status", "all").upper()
    if status_filter not in {"ALL", "COMPLETED", "PENDING", "REVERSED"}:
        raise HTTPException(status_code=422, detail="Choose a valid transaction status.")
    sort = params.get("sort", "date_desc")
    if sort not in {"date_asc", "date_desc", "amount_asc", "amount_desc"}:
        raise HTTPException(status_code=422, detail="Choose a valid sort order.")

    return {
        "q": params.get("q", "")[:120],
        "from": parse_date_bound(start_value),
        "to_exclusive": parse_date_bound(end_value, end=True),
        "min_amount": minimum,
        "max_amount": maximum,
        "direction": direction,
        "status": status_filter,
        "sort": sort,
    }


def _portal_page(request: Request) -> tuple[int, int]:
    try:
        page = max(1, int(request.query_params.get("page", "1")))
        page_size = min(50, max(1, int(request.query_params.get("page_size", "20"))))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Page and page size must be whole numbers.") from exc
    return page, page_size


@app.post("/api/portal/signup")
async def portal_signup(payload: PortalSignupRequest, request: Request, response: Response):
    _check_portal_origin(request)
    try:
        user, token, accounts = portal_signup_customer(payload.email, payload.name, payload.password)
    except ValueError as exc:
        message = str(exc)
        raise HTTPException(status_code=409 if "already exists" in message or "full" in message else 422, detail=message) from exc
    _set_portal_session_cookie(response, request, token)
    portal_record_audit(int(user["id"]), "signup", "user", str(user["id"]))
    return {"user": user, "accounts": accounts}


@app.post("/api/portal/login")
async def portal_login(payload: PortalLoginRequest, request: Request, response: Response):
    _check_portal_origin(request)
    source = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    if not source:
        source = request.client.host if request.client else "unknown"
    try:
        user, token, accounts = portal_login_customer(payload.email, payload.password, source)
    except PortalRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "900"}) from exc
    if not user:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    _set_portal_session_cookie(response, request, token)
    portal_record_audit(int(user["id"]), "login", "user", str(user["id"]))
    return {"user": user, "accounts": accounts}


@app.post("/api/portal/logout")
async def portal_logout(request: Request, response: Response):
    _check_portal_origin(request)
    session_token = request.cookies.get(CUSTOMER_SESSION_COOKIE)
    customer = portal_customer_for_session(session_token)
    if customer:
        portal_record_audit(int(customer["id"]), "logout", "user", str(customer["id"]))
    portal_logout_customer(session_token)
    response.delete_cookie(key=CUSTOMER_SESSION_COOKIE, httponly=True, secure=_portal_cookie_secure(request), samesite="lax", path="/")
    return {"success": True}


@app.get("/api/portal/me")
async def portal_me(request: Request):
    customer = _require_portal_customer(request)
    accounts = portal_customer_accounts(int(customer["id"]))
    portal_record_audit(int(customer["id"]), "view_profile", "user", str(customer["id"]))
    return {"user": customer, "accounts": accounts}


@app.patch("/api/portal/profile")
async def portal_update_profile(payload: PortalProfileRequest, request: Request):
    _check_portal_origin(request)
    customer = _require_portal_customer(request)
    try:
        user = portal_update_customer_name(int(customer["id"]), payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    portal_record_audit(int(customer["id"]), "update_profile", "user", str(customer["id"]))
    return {"user": user}


@app.post("/api/portal/password")
async def portal_change_password(payload: PortalPasswordRequest, request: Request):
    _check_portal_origin(request)
    customer = _require_portal_customer(request)
    try:
        portal_change_customer_password(
            int(customer["id"]),
            payload.current_password,
            payload.new_password,
            request.cookies.get(CUSTOMER_SESSION_COOKIE),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    portal_record_audit(int(customer["id"]), "change_password", "user", str(customer["id"]))
    return {"success": True}


@app.get("/api/portal/accounts")
async def portal_accounts(request: Request):
    customer = _require_portal_customer(request)
    accounts = portal_customer_accounts(int(customer["id"]))
    portal_record_audit(int(customer["id"]), "view_accounts", "account_collection")
    return {"accounts": accounts, "total": len(accounts)}


@app.get("/api/portal/intelligence")
async def portal_intelligence(request: Request):
    customer = _require_portal_customer(request)
    result = portal_customer_intelligence(int(customer["id"]))
    portal_record_audit(int(customer["id"]), "view_account_intelligence", "account_network")
    return result


@app.get("/api/portal/cases")
async def portal_customer_cases(request: Request):
    customer = _require_portal_customer(request)
    customer_cases = portal_reported_cases(int(customer["id"]))
    owned_case_ids = {str(item["case_id"]) for item in customer_cases}
    case_status = {
        str(item.get("case_id")): item
        for item in load_cases()
        if isinstance(item, dict) and str(item.get("case_id", "")) in owned_case_ids
    }
    # Keep the customer response limited to their submitted transaction and
    # basic case progress; analyst notes and other case evidence stay private.
    visible_cases = []
    for item in customer_cases:
        current = case_status.get(str(item["case_id"]), {})
        visible_cases.append({
            "case_id": item["case_id"],
            "account_id": item["account_id"],
            "transaction_id": item["transaction_id"],
            "status": str(current.get("status") or item["status"]),
            "priority": str(current.get("priority") or item["priority"]),
            "created_at": item["created_at"],
            "transaction_timestamp": item["transaction_timestamp"],
            "transaction_status": item["transaction_status"],
            "amount": item["amount"],
            "currency": item["currency"],
            "merchant": item["merchant_id"],
        })
    portal_record_audit(int(customer["id"]), "view_reported_cases", "case_collection")
    return {"cases": visible_cases, "total": len(visible_cases)}


@app.get("/api/portal/transactions")
async def portal_transactions(request: Request):
    customer = _require_portal_customer(request)
    filters = _portal_filters(request)
    page, page_size = _portal_page(request)
    transactions, total = portal_list_customer_transactions(int(customer["id"]), filters, limit=page_size, offset=(page - 1) * page_size)
    portal_record_audit(int(customer["id"]), "view_transactions", "transaction_collection")
    return {"transactions": transactions, "total": total, "page": page, "page_size": page_size, "pages": (total + page_size - 1) // page_size}


@app.get("/api/portal/transactions/export.csv")
async def portal_transactions_export(request: Request):
    customer = _require_portal_customer(request)
    filters = _portal_filters(request)
    transactions, _total = portal_list_customer_transactions(int(customer["id"]), filters)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Transaction ID", "Date", "Direction", "Account", "Counterparty", "Amount", "Currency", "Status", "Merchant", "Location"])
    for transaction in transactions:
        counterparty = transaction["target_account"] if transaction["direction"] == "outgoing" else transaction["source_account"]
        writer.writerow([
            transaction["transaction_id"], transaction["timestamp"], transaction["direction"], transaction["account_id"],
            counterparty, f"{float(transaction['amount']):.2f}", transaction["currency"], transaction["status"],
            transaction.get("merchant") or "", transaction.get("location") or "",
        ])
    portal_record_audit(int(customer["id"]), "export_transactions", "transaction_collection")
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=fin-sentinels-transactions.csv", "Cache-Control": "no-store"},
    )


@app.get("/api/portal/transactions/{transaction_id}")
async def portal_transaction_detail(transaction_id: str, request: Request):
    customer = _require_portal_customer(request)
    transaction = portal_get_customer_transaction(int(customer["id"]), transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found in your linked accounts.")
    portal_record_audit(int(customer["id"]), "view_transaction", "transaction", transaction_id)
    return {"transaction": transaction}


@app.post("/api/portal/transactions/{transaction_id}/report")
async def portal_report_transaction(transaction_id: str, payload: PortalReportRequest, request: Request):
    _check_portal_origin(request)
    customer = _require_portal_customer(request)
    transaction = portal_get_customer_transaction(int(customer["id"]), transaction_id)
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found in your linked accounts.")
    account_id = str(transaction["account_id"])
    message = " ".join(payload.message.split())[:1200]
    existing = portal_reported_case(int(customer["id"]), transaction_id)
    if existing:
        return {"success": True, "existing": True, "case_id": existing["case_id"], "message": "This transaction was already reported."}
    note = f"Customer report for {transaction_id}."
    if message:
        note += f" Customer note: {message}"
    graph = load_graph_data()
    if account_id in graph and graph.nodes[account_id].get("type") == "account":
        case_result = await create_case(CaseCreate(account_id=account_id, priority="HIGH", note=note))
        # If an analyst already has an active account case, attach this report
        # and transaction evidence to that record instead of losing the note.
        cases = load_cases()
        target_case = next((item for item in cases if isinstance(item, dict) and item.get("case_id") == case_result.get("case_id")), None)
        if target_case:
            transaction_ids = target_case.setdefault("transaction_ids", [])
            if transaction_id not in transaction_ids:
                transaction_ids.append(transaction_id)
            evidence = target_case.setdefault("evidence", [])
            if not any(transaction_id in item.get("transaction_ids", []) for item in evidence if isinstance(item, dict)):
                evidence.append({
                    "evidence_id": f"EVD-CUSTOMER-{uuid.uuid4().hex[:10].upper()}",
                    "evidence_type": "Customer report",
                    "description": message or "Customer asked for this synthetic transaction to be reviewed.",
                    "transaction_ids": [transaction_id],
                    "timestamp": utc_now(),
                })
            target_case["note"] = " ".join(part for part in (str(target_case.get("note", "")).strip(), note) if part)
            target_case.setdefault("timeline", []).append({
                "event_id": f"EVT-CUSTOMER-{uuid.uuid4().hex[:10].upper()}",
                "type": "CUSTOMER_REPORT",
                "title": "Customer reported a transaction",
                "description": f"A customer requested review of transaction {transaction_id}.",
                "timestamp": utc_now(),
            })
            save_cases(cases)
    else:
        # Generated customer accounts are deliberately private and absent from
        # the national analyst graph. Keep the report visible as an unscored
        # case rather than fabricating a graph risk score or rejecting it.
        cases = load_cases()
        now = utc_now()
        case_id = next_case_id(cases)
        case_record = {
            "case_id": case_id,
            "account_id": account_id,
            "priority": "HIGH",
            "status": "OPEN",
            "risk_status": "UNSCORED",
            "note": note,
            "transaction_ids": [transaction_id],
            "evidence": [{
                "evidence_id": f"EVD-CUSTOMER-{uuid.uuid4().hex[:10].upper()}",
                "evidence_type": "Customer report",
                "description": message or "Customer asked for this synthetic transaction to be reviewed.",
                "transaction_ids": [transaction_id],
                "timestamp": now,
            }],
            "timeline": [{
                "event_id": "EVT-0001",
                "type": "CASE_CREATED",
                "title": "Customer report received",
                "description": f"A customer requested review of synthetic transaction {transaction_id}.",
                "timestamp": now,
            }],
            "created_at": now,
            "updated_at": now,
        }
        cases.append(case_record)
        save_cases(cases)
        case_result = {"success": True, "existing": False, **case_record}
    case_id = str(case_result.get("case_id", ""))
    if not case_id:
        raise HTTPException(status_code=500, detail="The report could not be added to the analyst case queue.")
    portal_record_reported_case(int(customer["id"]), case_id, account_id, transaction_id)
    portal_record_audit(int(customer["id"]), "report_transaction", "transaction", transaction_id)
    return {"success": True, "existing": bool(case_result.get("existing")), "case_id": case_id, "message": "Your report was added to the analyst case queue."}


@app.get("/")
def dashboard():
    # Route the API root to the authenticated Next.js workspace. The old
    # static page used a client-side demo code and exposed the API directly.
    frontend_url = os.getenv("FIN_SENTINELS_FRONTEND_URL", "http://127.0.0.1:3000/").strip()
    return RedirectResponse(url=frontend_url, status_code=307)


@app.get("/app.js")
def app_js():
    raise HTTPException(status_code=404, detail="The legacy browser interface is retired.")


# ============================================================
# HEALTH
# ============================================================

@app.get("/api/health")
def health():
    try:
        runtime_storage_writable = os.access(RUNTIME_DATA_DIR, os.W_OK)
        if not runtime_storage_writable:
            raise HTTPException(
                status_code=503,
                detail="Persistent application storage is not writable.",
            )
        G = load_graph_data()
        transactions = load_transactions()
        data_files = [os.path.basename(path) for path in find_data_files()]

        return {
            "status": "healthy",
            "service": "FinSentinels API",
            "version": app.version,
            "nodes": G.number_of_nodes(),
            "edges": G.number_of_edges(),
            "transactions": len(transactions),
            "data_mode": DATA_MODE,
            "data_files": data_files,
            "runtime_storage_writable": runtime_storage_writable,
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.get("/api/public/summary")
def public_summary():
    """Expose only aggregate synthetic preview counts on the public landing page."""
    if DATA_MODE != "demo":
        return {
            "data_mode": DATA_MODE,
            "public_stats_available": False,
        }

    try:
        graph = load_graph_data()
        transactions = load_transactions()
        account_count = sum(1 for _node, data in graph.nodes(data=True) if data.get("type") == "account")
        transfer_count = sum(1 for _source, _target, data in graph.edges(data=True) if data.get("edge_type") == "TRANSFER")
        latest = max(
            (transaction.get("timestamp_dt") for transaction in transactions if isinstance(transaction.get("timestamp_dt"), datetime)),
            default=None,
        )
        return {
            "data_mode": "demo",
            "public_stats_available": True,
            "accounts_monitored": account_count,
            "transfer_records": transfer_count,
            "last_activity": latest.isoformat() if latest else None,
        }
    except Exception as exc:
        logger.exception("Could not prepare public aggregate sample metrics")
        raise HTTPException(status_code=503, detail="Public sample metrics are unavailable.") from exc


# ============================================================
# DATA QUALITY
# ============================================================

@app.get("/api/data-quality")
def data_quality():
    try:
        transactions = load_transactions()

        ids = [
            tx["transaction_id"]
            for tx in transactions
        ]

        duplicate_count = (
            len(ids) - len(set(ids))
        )

        accounts = {
            tx["source_account"]
            for tx in transactions
        } | {
            tx["target_account"]
            for tx in transactions
        }

        return {
            "status": (
                "empty" if not transactions else "valid" if duplicate_count == 0 else "invalid"
            ),
            "transaction_count": len(
                transactions
            ),
            "unique_transaction_ids": len(
                set(ids)
            ),
            "duplicate_transaction_ids": (
                duplicate_count
            ),
            "account_count": len(accounts),
            "data_mode": DATA_MODE,
            "data_files": [os.path.basename(path) for path in find_data_files()],
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# ============================================================
# SCORE
# ============================================================

@app.get("/api/score/{account_id}")
async def score(account_id: str):
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

        result["transactions"] = (
            get_account_transactions(
                G,
                aid,
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


# ============================================================
# ACCOUNT GRAPH
# ============================================================

@app.get("/api/graph/{account_id}")
@app.get("/api/transaction/{account_id}")
def graph(account_id: str, depth: int | None = None):
    try:
        G = load_graph_data()
        settings = get_settings()

        aid = account_id.strip().upper()

        if (
            aid not in G
            or G.nodes[aid].get("type")
            != "account"
        ):
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Account '{aid}' not found"
                ),
            )

        return {
            "account_id": aid,
            "graph": get_subgraph(
                G,
                aid,
                depth=settings["graph_depth"] if depth is None else depth,
            ),
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# ============================================================
# NETWORK
# ============================================================

@app.get("/api/network")
async def network(scope: str = "alerts"):
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

            for aid, node_data in G.nodes(
                data=True
            ):
                if node_data.get("type") != "account":
                    continue

                result = analyze_with_settings(
                    G,
                    aid,
                    settings,
                )

                if result["status"] == "HIGH RISK":
                    alert_ids.add(aid)

            # Fallback to WATCH when no HIGH RISK
            # accounts are available in the dataset.
            if not alert_ids:
                for aid, node_data in G.nodes(
                    data=True
                ):
                    if node_data.get(
                        "type"
                    ) != "account":
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


# ============================================================
# ACCOUNTS
# ============================================================

@app.get("/api/accounts")
async def accounts():
    try:
        G = load_graph_data()
        settings = get_settings()

        rows = []

        for account_id, node_data in G.nodes(
            data=True
        ):
            if node_data.get(
                "type"
            ) != "account":
                continue

            result = analyze_with_settings(
                G,
                account_id,
                settings,
            )

            rows.append(
                {
                    "account_id": account_id,
                    "risk_score": result[
                        "risk_score"
                    ],
                    "account_risk_score": result.get(
                        "account_risk_score",
                        result["risk_score"],
                    ),
                    "network_risk_score": result.get(
                        "network_risk_score",
                        result["risk_score"],
                    ),
                    "status": result["status"],
                    "mule_account": result.get(
                        "mule_account",
                        False,
                    ),
                    "in_fraud_ring": bool(result.get("cycle_count", 0)),
                    "cycle_count": int(result.get("cycle_count", 0) or 0),
                    "flow_metrics": result.get("flow_metrics", {}),
                    "gnn": result.get("gnn", {}),
                }
            )

        rows.sort(
            key=lambda item: item[
                "account_id"
            ]
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


# ============================================================
# RECENT TRANSACTIONS
# ============================================================

@app.get("/api/transactions/recent")
def recent_transactions(
    limit: int = 12,
):
    try:
        limit = max(
            1,
            min(
                int(limit),
                50,
            ),
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


# ============================================================
# ALERTS
# ============================================================

@app.get("/api/alerts")
async def alerts():
    try:
        G = load_graph_data()
        settings = get_settings()

        output = []

        for aid, node_data in G.nodes(
            data=True
        ):
            if node_data.get(
                "type"
            ) != "account":
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
                    "risk_score": result[
                        "risk_score"
                    ],
                    "status": result["status"],
                    "reasons": result[
                        "reasons"
                    ],
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
            key=lambda x: x[
                "risk_score"
            ],
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


# ============================================================
# ANALYTICS
# ============================================================

@app.get("/api/intelligence")
async def national_intelligence():
    """Return a nationwide graph-level snapshot for the currently connected data."""
    try:
        G = load_graph_data()
        settings = get_settings()
        transactions = load_transactions()
        latest_transaction = max(
            (tx["timestamp_dt"] for tx in transactions),
            default=None,
        )
        account_ids = sorted(node for node, data in G.nodes(data=True)
                             if data.get("type") == "account")
        scores = [analyze_with_settings(G, aid, settings) for aid in account_ids]
        # This national index summarizes every account-context network score.
        # Keep the peak separately so a concentrated high-risk cohort is not
        # hidden by the national mean.
        network_risk = round(sum(item["risk_score"] for item in scores) / len(scores)) if scores else 0
        peak_network_risk = max((item["risk_score"] for item in scores), default=0)
        countries = sorted({country.strip() for _u, _v, edge in G.edges(data=True)
                            if edge.get("edge_type") == "TRANSFER"
                            for country in (edge.get("source_country"), edge.get("target_country"), edge.get("location_country"))
                            if country and country.strip()})
        country_routes = sorted({f"{edge.get('source_country').strip()} → {edge.get('target_country').strip()}"
                                 for _u, _v, edge in G.edges(data=True)
                                 if edge.get("edge_type") == "TRANSFER"
                                 and edge.get("source_country") and edge.get("target_country")
                                 and edge.get("source_country").strip().casefold() != edge.get("target_country").strip().casefold()})
        shared_device_count = 0
        for node, data in G.nodes(data=True):
            if data.get("type") == "device":
                users = {u for u, _v, _k, edge in G.in_edges(node, keys=True, data=True)
                         if edge.get("edge_type") == "USED_DEVICE"}
                shared_device_count += int(len(users) > 1)
        shared_ip_count = 0
        for node, data in G.nodes(data=True):
            if data.get("type") == "ip_address":
                users = {u for u, _v, _k, edge in G.in_edges(node, keys=True, data=True)
                         if edge.get("edge_type") == "USED_IP"}
                shared_ip_count += int(len(users) > 1)
        return {
            "scope": "national_graph_intelligence",
            "source_mode": (
                "synthetic demonstration data"
                if DATA_MODE == "demo"
                else "production data awaiting ingestion"
                if G.number_of_edges() == 0
                else "ingested production data"
            ),
            "data_mode": DATA_MODE,
            "source_connection": "POST /api/ingest",
            "network_score_method": "Mean of network-aware account-context scores across the national graph; a ranking index, not a calibrated fraud probability.",
            "network_risk_score": network_risk,
            "peak_cohort_risk_score": peak_network_risk,
            "network_status": status_from_score(network_risk, settings),
            "account_count": len(account_ids),
            "transaction_count": sum(1 for _u, _v, edge in G.edges(data=True)
                                      if edge.get("edge_type") == "TRANSFER"),
            "high_risk_network_accounts": sum(1 for item in scores if item["status"] == "HIGH RISK"),
            "watch_network_accounts": sum(1 for item in scores if item["status"] == "WATCH"),
            # The ranking is already computed for the national aggregates. Reuse
            # it to give the landing desk a useful review list without a second
            # /api/accounts pass over the same graph.
            "priority_accounts": [
                {
                    "account_id": item["account_id"],
                    "risk_score": item["risk_score"],
                    "status": item["status"],
                    "reasons": item.get("reasons", [])[:2],
                    "cycle_count": int(item.get("cycle_count", 0) or 0),
                    "mule_account": bool(item.get("mule_account", False)),
                }
                for item in sorted(scores, key=lambda item: item["risk_score"], reverse=True)[:8]
            ],
            "shared_device_count": shared_device_count,
            "shared_ip_count": shared_ip_count,
            "observed_countries": countries,
            "observed_routes": country_routes,
            "last_updated": utc_now(),
            "last_transaction_at": latest_transaction.isoformat() if latest_transaction else None,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/analytics")
async def analytics():
    try:
        G = load_graph_data()
        settings = get_settings()

        account_nodes = [
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
            if d.get("edge_type")
            == "TRANSFER"
        ]

        risk = {
            "high_risk": 0,
            "watch": 0,
            "safe": 0,
        }

        scores = []
        mule_accounts = 0

        for aid in account_nodes:
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
            account_nodes
        )

        for u, v, _k, d in G.edges(
            keys=True,
            data=True,
        ):
            if d.get(
                "edge_type"
            ) == "TRANSFER":
                account_graph.add_edge(
                    u,
                    v,
                )

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
                for (
                    source,
                    _target,
                    _key,
                    edge,
                ) in G.in_edges(
                    device,
                    keys=True,
                    data=True,
                )
                if (
                    edge.get(
                        "edge_type"
                    )
                    == "USED_DEVICE"
                    and G.nodes[
                        source
                    ].get(
                        "type"
                    )
                    == "account"
                )
            }

            if len(users) > 1:
                shared_device_details.append(
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

        cases = load_cases()

        return {
            "generated_at": utc_now(),
            "network": {
                "accounts": len(
                    account_nodes
                ),
                "devices": len(devices),
                "merchants": len(
                    merchants
                ),
                "locations": len(
                    locations
                ),
                "transactions": len(
                    transfers
                ),
                "connections": (
                    G.number_of_edges()
                ),
            },
            "risk_distribution": risk,
            "fraud_patterns": {
                "active_cycles": len(
                    cycle_groups
                ),
                "shared_devices": len(
                    shared_device_details
                ),
                "mule_accounts": (
                    mule_accounts
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
                        / len(transfers),
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
                shared_device_details
            ),
            "case_metrics": {
                "total": len(cases),
                "open": sum(
                    1
                    for c in cases
                    if (
                        isinstance(
                            c,
                            dict,
                        )
                        and c.get(
                            "status"
                        )
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
                        isinstance(
                            c,
                            dict,
                        )
                        and c.get(
                            "status"
                        )
                        == "INVESTIGATING"
                    )
                ),
                "closed": sum(
                    1
                    for c in cases
                    if (
                        isinstance(
                            c,
                            dict,
                        )
                        and c.get(
                            "status"
                        )
                        == "CLOSED"
                    )
                ),
                "dismissed": sum(
                    1
                    for c in cases
                    if (
                        isinstance(
                            c,
                            dict,
                        )
                        and c.get(
                            "status"
                        )
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


# ============================================================
# CASES
# ============================================================

@app.get("/api/cases")
async def get_cases():
    try:
        cases = load_cases()
        G = load_graph_data()
        settings = get_settings()
        cases = [dict(case) for case in cases if isinstance(case, dict)]
        for case in cases:
            aid = str(case.get("account_id", "")).strip().upper()
            if aid in G and G.nodes[aid].get("type") == "account":
                analysis = analyze_with_settings(G, aid, settings)
                case.update({"risk_score": analysis["risk_score"],
                             "risk_status": analysis["status"],
                             "network_risk_score": analysis.get("network_risk_score"),
                             "reasons": analysis.get("reasons", [])})

        cases.sort(
            key=lambda item: (
                item.get(
                    "created_at",
                    "",
                )
                if isinstance(
                    item,
                    dict,
                )
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
async def get_case(
    case_id: str,
):
    try:
        cases = load_cases()

        target_id = case_id.strip()

        item = next(
            (
                case
                for case in cases
                if (
                    isinstance(
                        case,
                        dict,
                    )
                    and case.get(
                        "case_id"
                    )
                    == target_id
                )
            ),
            None,
        )

        if not item:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Case '{target_id}' "
                    "not found"
                ),
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

        result["timeline"] = (
            build_case_timeline(
                G,
                aid,
                result,
            )
        )

        if analysis:
            result["analysis"] = analysis
            result["risk_score"] = analysis["risk_score"]
            result["risk_status"] = analysis["status"]
            result["network_risk_score"] = analysis.get("network_risk_score")
            result["reasons"] = analysis.get("reasons", result.get("reasons", []))

        return result

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.post("/api/cases")
async def create_case(
    case: CaseCreate,
):
    try:
        G = load_graph_data()
        settings = get_settings()

        aid = case.account_id.strip().upper()

        if (
            aid not in G
            or G.nodes[aid].get(
                "type"
            )
            != "account"
        ):
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Account '{aid}' "
                    "not found"
                ),
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
                    isinstance(
                        item,
                        dict,
                    )
                    and item.get(
                        "account_id"
                    )
                    == aid
                    and item.get(
                        "status"
                    )
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
                "message": (
                    "An active case already "
                    "exists for this account."
                ),
                **existing,
            }

        now = utc_now()

        new_case = {
            "case_id": next_case_id(
                cases
            ),
            "account_id": aid,
            "priority": case.priority,
            "status": "OPEN",
            "risk_score": result[
                "risk_score"
            ],
            "network_risk_score": result.get("network_risk_score", result["risk_score"]),
            "risk_status": result[
                "status"
            ],
            "reasons": result.get(
                "reasons",
                [],
            ),
            "note": case.note.strip(),
            "evidence": [
                {
                    "evidence_id": (
                        f"EVD-AUTO-{idx:03d}"
                    ),
                    "evidence_type": (
                        "Graph signal"
                    ),
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
                        f"Case created from "
                        f"the {aid} graph "
                        "investigation."
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
            "message": (
                "Case created successfully."
            ),
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
                not isinstance(
                    item,
                    dict,
                )
                or item.get(
                    "case_id"
                )
                != target_id
            ):
                continue

            old_status = str(
                item.get(
                    "status",
                    "OPEN",
                )
            ).upper()
            old_priority = str(
                item.get(
                    "priority",
                    "MEDIUM",
                )
            ).upper()

            if update.status is not None:
                item["status"] = (
                    update.status
                )

            if update.note is not None:
                item["note"] = (
                    update.note.strip()
                )

            if update.priority is not None:
                item["priority"] = (
                    update.priority
                )

            item["updated_at"] = utc_now()

            if (
                item.get("status")
                != old_status
            ):
                add_timeline_event(
                    item,
                    (
                        f"Status changed "
                        f"to {item['status']}"
                    ),
                    (
                        f"Case moved from "
                        f"{old_status} to "
                        f"{item['status']}."
                    ),
                    "STATUS_CHANGE",
                )

            new_priority = str(
                item.get(
                    "priority",
                    "MEDIUM",
                )
            ).upper()
            if (
                update.priority is not None
                and new_priority != old_priority
            ):
                add_timeline_event(
                    item,
                    f"Priority changed to {new_priority}",
                    (
                        f"Case priority changed from "
                        f"{old_priority} to {new_priority}."
                    ),
                    "PRIORITY_CHANGE",
                )

            save_cases(cases)

            return {
                "success": True,
                "message": (
                    f"{target_id} updated."
                ),
                **item,
            }

        raise HTTPException(
            status_code=404,
            detail=(
                f"Case '{target_id}' "
                "not found"
            ),
        )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


@app.post(
    "/api/cases/{case_id}/evidence"
)
def add_evidence(
    case_id: str,
    evidence: EvidenceCreate,
):
    try:
        if evidence.transaction_ids:
            known_transaction_ids = {
                str(tx.get("transaction_id", ""))
                for tx in load_transactions()
            }
            unknown_transaction_ids = [
                transaction_id
                for transaction_id in evidence.transaction_ids
                if transaction_id not in known_transaction_ids
            ]
            if unknown_transaction_ids:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Unknown transaction IDs: "
                        + ", ".join(unknown_transaction_ids[:10])
                    ),
                )

        cases = load_cases()

        target_id = case_id.strip()

        for item in cases:
            if (
                not isinstance(
                    item,
                    dict,
                )
                or item.get(
                    "case_id"
                )
                != target_id
            ):
                continue

            records = item.setdefault(
                "evidence",
                [],
            )

            record = {
                "evidence_id": (
                    f"EVD-{len(records) + 1:04d}"
                ),
                "evidence_type": (
                    evidence.evidence_type
                ),
                "description": (
                    evidence.description
                ),
                "transaction_ids": evidence.transaction_ids,
                "timestamp": utc_now(),
            }

            records.append(record)

            add_timeline_event(
                item,
                "Evidence added",
                (
                    f"{evidence.evidence_type}: "
                    f"{evidence.description}"
                    + (
                        f" · Transactions: {', '.join(evidence.transaction_ids)}"
                        if evidence.transaction_ids
                        else ""
                    )
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
            detail=(
                f"Case '{target_id}' "
                "not found"
            ),
        )

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


MAX_CASE_EVIDENCE_BYTES = 10 * 1024 * 1024
CASE_EVIDENCE_TYPES = {
    ".pdf": ("application/pdf", b"%PDF-"),
    ".png": ("image/png", b"\x89PNG\r\n\x1a\n"),
    ".jpg": ("image/jpeg", b"\xff\xd8\xff"),
    ".jpeg": ("image/jpeg", b"\xff\xd8\xff"),
}


@app.post("/api/cases/{case_id}/evidence/upload")
async def upload_case_evidence(
    case_id: str,
    file: UploadFile = File(...),
    evidence_type: str = Form(...),
    description: str = Form(default=""),
):
    try:
        target_id = case_id.strip()
        evidence_type = evidence_type.strip()
        description = description.strip()
        if not evidence_type or len(evidence_type) > 120:
            raise HTTPException(status_code=422, detail="Evidence type is required and must be at most 120 characters.")
        if len(description) > 5000:
            raise HTTPException(status_code=422, detail="Evidence description must be at most 5000 characters.")

        cases = load_cases()
        item = next(
            (
                case
                for case in cases
                if isinstance(case, dict) and case.get("case_id") == target_id
            ),
            None,
        )
        if item is None:
            raise HTTPException(status_code=404, detail=f"Case '{target_id}' not found.")

        original_name = (file.filename or "evidence").replace("\\", "/").rsplit("/", 1)[-1]
        original_name = re.sub(r"[^A-Za-z0-9._ -]", "_", original_name).strip(" .")[:180] or "evidence"
        suffix = Path(original_name).suffix.lower()
        file_type = CASE_EVIDENCE_TYPES.get(suffix)
        if file_type is None:
            raise HTTPException(status_code=415, detail="Only PDF, PNG, and JPG evidence files are accepted.")

        content = await file.read(MAX_CASE_EVIDENCE_BYTES + 1)
        if not content:
            raise HTTPException(status_code=422, detail="The uploaded evidence file is empty.")
        if len(content) > MAX_CASE_EVIDENCE_BYTES:
            raise HTTPException(status_code=413, detail="Evidence files may not exceed 10 MB each.")
        _, signature = file_type
        if not content.startswith(signature):
            raise HTTPException(status_code=415, detail="The file contents do not match its PDF, PNG, or JPG extension.")

        stored_name = f"{uuid.uuid4().hex}{suffix}"
        case_folder = hashlib.sha256(target_id.encode("utf-8")).hexdigest()[:24]
        storage_dir = CASE_EVIDENCE_DIR / case_folder
        storage_dir.mkdir(parents=True, exist_ok=True)
        (storage_dir / stored_name).write_bytes(content)

        records = item.setdefault("evidence", [])
        evidence_id = f"EVD-{len(records) + 1:04d}"
        record = {
            "evidence_id": evidence_id,
            "evidence_type": evidence_type,
            "description": description,
            "timestamp": utc_now(),
            "file_name": original_name,
            "storage_name": stored_name,
            "file_url": f"/api/cases/{target_id}/evidence/{evidence_id}/file",
            "file_size": len(content),
            "media_type": file_type[0],
        }
        records.append(record)
        add_timeline_event(item, "Evidence uploaded", f"{evidence_type}: {original_name}", "EVIDENCE")
        item["updated_at"] = utc_now()
        save_cases(cases)
        return {"success": True, "evidence": record, "case": item}

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()


@app.get("/api/cases/{case_id}/evidence/{evidence_id}/file")
def download_case_evidence(case_id: str, evidence_id: str):
    cases = load_cases()
    item = next(
        (
            case
            for case in cases
            if isinstance(case, dict) and case.get("case_id") == case_id.strip()
        ),
        None,
    )
    evidence = next(
        (
            entry
            for entry in (item or {}).get("evidence", [])
            if isinstance(entry, dict) and entry.get("evidence_id") == evidence_id
        ),
        None,
    )
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence file not found.")

    stored_name = evidence.get("storage_name", "")
    if not re.fullmatch(r"[0-9a-f]{32}\.(?:pdf|png|jpg|jpeg)", stored_name):
        raise HTTPException(status_code=404, detail="Evidence file not found.")

    case_folder = hashlib.sha256(case_id.strip().encode("utf-8")).hexdigest()[:24]
    file_path = CASE_EVIDENCE_DIR / case_folder / stored_name
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Evidence file is missing from local storage.")
    media_type = CASE_EVIDENCE_TYPES[file_path.suffix.lower()][0]
    return FileResponse(file_path, media_type=media_type, filename=evidence.get("file_name", "evidence"))


# ============================================================
# INGESTION
# ============================================================

@app.post("/api/ingest")
async def ingest(
    batch: IngestBatch,
):
    try:
        existing = load_transactions()
        existing_ids = {tx["transaction_id"] for tx in existing}
        incoming = [tx.model_dump() for tx in batch.transactions]
        incoming_ids = [tx["transaction_id"] for tx in batch.transactions]
        duplicates = sorted(existing_ids.intersection(incoming_ids))
        if len(incoming_ids) != len(set(incoming_ids)):
            raise HTTPException(status_code=409, detail="Batch contains duplicate transaction IDs")
        if duplicates:
            raise HTTPException(status_code=409, detail=f"Transaction IDs already exist: {', '.join(duplicates[:10])}")
        LIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
        current_live = []
        if LIVE_FILE.exists():
            with LIVE_FILE.open("r", encoding="utf-8") as handle:
                current_live = json.load(handle)
        updated = current_live + incoming
        temp_file = LIVE_FILE.with_suffix(".json.tmp")
        with FILE_LOCK:
            with temp_file.open("w", encoding="utf-8") as handle:
                json.dump(updated, handle, indent=2, ensure_ascii=False)
            os.replace(temp_file, LIVE_FILE)
        invalidate_cache()
        GNN_TRANSACTIONS.extend(incoming)
        G = load_graph_data()
        affected = sorted({tx["source_account"].upper() for tx in incoming}
                          | {tx["target_account"].upper() for tx in incoming})
        settings = get_settings()
        return {"accepted": len(incoming), "mode": "live_graph_ingestion",
                "streaming_ready": True, "network_refresh": "immediate",
                "affected_accounts": [{"account_id": aid,
                    "network_risk_score": analyze_with_settings(G, aid, settings)["risk_score"]}
                    for aid in affected]}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transaction ingestion failed: {exc}") from exc


@app.get("/api/integrations/obp/status")
def get_obp_status():
    """Return readiness flags only; provider credentials and payloads stay private."""
    return obp_status()


@app.post("/api/integrations/obp/webhook", include_in_schema=False)
async def obp_webhook(request: Request):
    raw_body = await request.body()
    signature_header = os.getenv("OBP_WEBHOOK_SIGNATURE_HEADER", "x-sandbox-signature").strip().lower()
    if not os.getenv("OBP_WEBHOOK_SECRET", "").strip():
        raise HTTPException(status_code=503, detail="Bank event intake is not configured.")
    if not verify_webhook_signature(raw_body, request.headers.get(signature_header)):
        raise HTTPException(status_code=401, detail="Bank event signature is invalid.")
    try:
        payload = json.loads(raw_body.decode("utf-8"))
        normalized = await asyncio.to_thread(normalize_obp_event, payload)
        record = IngestTransaction(**normalized)
        result = await ingest(IngestBatch(transactions=[record]))
        return {"accepted": result["accepted"], "status": "processed"}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Bank event must be valid JSON.") from exc
    except OBPError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException as exc:
        if exc.status_code == 409:
            # Provider callbacks are at-least-once; duplicate IDs are already
            # represented in the graph, so acknowledge them idempotently.
            return {"accepted": 0, "status": "already_processed"}
        raise


@app.post("/api/integrations/obp/sync")
async def obp_sync():
    try:
        normalized, skipped = await asyncio.to_thread(sync_obp_transactions)
        existing_ids = {tx["transaction_id"] for tx in load_transactions()}
        new_rows = [row for row in normalized if row.get("transaction_id") not in existing_ids]
        if not new_rows:
            return {"accepted": 0, "already_present": len(normalized), "skipped": skipped, "status": "up_to_date"}
        result = await ingest(IngestBatch(transactions=[IngestTransaction(**row) for row in new_rows]))
        return {"accepted": result["accepted"], "already_present": len(normalized) - len(new_rows), "skipped": skipped, "status": "synchronized"}
    except OBPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Bank ledger synchronization failed.") from exc


def _agent_widgets_for_account(
    G,
    account_id: str,
    transaction_id: str,
    settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    analysis = analyze_with_settings(G, account_id, settings if settings is not None else get_settings())
    timestamp = utc_now()
    evidence = analysis.get("network", {}).get("explanation", [])
    if not evidence:
        evidence = analysis.get("reasons", [])
    gnn = analysis.get("gnn", {})
    network_components = analysis.get("network", {}).get("score_components", {})
    model_components = analysis.get("score_components", {})
    account_factors = analysis.get("factors", {})
    flow_metrics = analysis.get("flow_metrics", {})
    network = analysis.get("network", {})
    shared_devices = analysis.get("shared_devices", [])
    graph_evidence = [str(item) for item in analysis.get("reasons", [])]
    graph_evidence.extend(
        str(item) for item in gnn.get("evidence", []) if item
    )
    score_math = analysis.get("explanation", {}).get("score_math", {})
    if score_math:
        graph_evidence.append(
            "Score calculation: "
            f"{score_math.get('base_label', 'Account signal')} "
            f"({score_math.get('base_account_id', account_id)}) "
            f"{score_math.get('base_score', 0)}/100 + "
            f"{score_math.get('network_uplift', 0)} linked-network points = "
            f"{score_math.get('network_score', analysis.get('risk_score', 0))}/100 "
            "(capped at 99)."
        )
    graph_evidence = list(dict.fromkeys(graph_evidence))
    high_value_signal = bool(
        analysis.get("factor_points", {}).get("high_value_activity", 0)
    )
    activity_evidence = [
        f"Transactions reviewed: {analysis.get('transaction_count', 0)}",
        f"Peak account activity: {flow_metrics.get('velocity_window_count', 0)} transaction(s) in a 60-minute window",
        f"Account-network degree: {analysis.get('degree', 0)}",
        f"Circular fund cycles: {analysis.get('cycle_count', 0)}",
        f"Shared device links: {len(shared_devices)}",
        f"Shared IP links: {network.get('shared_ip_count', 0)}",
        f"Cross-border transfers in linked network: {network.get('cross_border_transfer_count', 0)}",
        f"Mule-flow rule: {'triggered' if analysis.get('mule_account') else 'not triggered'}",
        f"High-value activity rule: {'triggered' if high_value_signal else 'not triggered'}",
        f"Inbound ₹{flow_metrics.get('inbound', 0):,.0f}",
        f"Outbound ₹{flow_metrics.get('outbound', 0):,.0f}",
        f"Pass-through {float(flow_metrics.get('pass_through_ratio', 0)):.0%}",
        f"Retention {float(flow_metrics.get('retention_ratio', 0)):.0%}",
    ]
    widgets = [
        AgentWidget(
            event_id=f"{transaction_id}:network:{account_id}",
            agent="Network Risk Rules",
            widget_type="risk-score",
            subject=account_id,
            score=int(analysis.get("risk_score", 0)),
            risk_level=analysis.get("status", "SAFE"),
            confidence=round(float(gnn["confidence"]), 2) if gnn.get("available") and gnn.get("confidence") is not None else None,
            confidence_label=gnn.get("confidence_label", "Not calibrated"),
            rationale=analysis.get("risk_explanation", "Network risk assessed from current graph evidence."),
            evidence=list(evidence),
            score_components={"network": network_components, "model": model_components},
            timestamp=timestamp,
        ).model_dump(),
        AgentWidget(
            event_id=f"{transaction_id}:graph:{account_id}",
            agent="Graph Structure Analysis",
            widget_type="evidence-list",
            subject=account_id,
            score=int(analysis.get("account_risk_score", 0)),
            risk_level=analysis.get("status", "SAFE"),
            confidence=round(float(gnn["confidence"]), 2) if gnn.get("available") and gnn.get("confidence") is not None else None,
            confidence_label=gnn.get("confidence_label", "Not calibrated"),
            rationale="Complete account-level rule and model evidence, including active and zero-valued factors.",
            evidence=graph_evidence,
            score_components={
                "account_signals": account_factors,
                "factor_points": analysis.get("factor_points", {}),
            },
            timestamp=timestamp,
        ).model_dump(),
        AgentWidget(
            event_id=f"{transaction_id}:behavior:{account_id}",
            agent="Account Behavior Rules",
            widget_type="evidence-list",
            subject=account_id,
            score=int(analysis.get("account_risk_score", 0)),
            risk_level=analysis.get("status", "SAFE"),
            confidence=None,
            confidence_label="Not calibrated",
            rationale="Per-account review of transfer totals, flow ratios, activity, connected infrastructure, and each behavior rule.",
            evidence=activity_evidence,
            score_components={
                "flow": {
                    "inbound_amount": flow_metrics.get("inbound", 0),
                    "outbound_amount": flow_metrics.get("outbound", 0),
                    "total_amount": flow_metrics.get("total", 0),
                    "pass_through_ratio": flow_metrics.get("pass_through_ratio", 0),
                    "retention_ratio": flow_metrics.get("retention_ratio", 0),
                    "peak_60_minute_transactions": flow_metrics.get("velocity_window_count", 0),
                },
                "network_context": {
                    "transaction_count": analysis.get("transaction_count", 0),
                    "account_network_degree": analysis.get("degree", 0),
                    "cycle_count": analysis.get("cycle_count", 0),
                    "shared_device_count": len(shared_devices),
                    "shared_ip_count": network.get("shared_ip_count", 0),
                    "linked_account_count": network.get("account_count", 1),
                    "cross_border_transfer_count": network.get("cross_border_transfer_count", 0),
                    "mule_flow_rule_triggered": bool(analysis.get("mule_account")),
                    "high_value_rule_triggered": high_value_signal,
                },
            },
            timestamp=timestamp,
        ).model_dump(),
    ]
    return widgets


def _agent_snapshot_widgets(G, account_ids: list[str]) -> list[dict[str, Any]]:
    settings = get_settings()
    widgets = []
    for account_id in account_ids:
        widgets.extend(
            _agent_widgets_for_account(
                G,
                account_id,
                f"snapshot:{account_id}",
                settings,
            )
        )
    return widgets


async def _initialize_gnn_in_background() -> None:
    """Import PyTorch and train the optional model without blocking the API."""
    global GNN_ENGINE, GNN_IMPORT_ERROR
    try:
        def create_engine():
            from ml_engine import create_engine as build_engine
            return build_engine(str(BASE_DIR))

        engine = await asyncio.to_thread(create_engine)
        GNN_ENGINE = engine
        GNN_IMPORT_ERROR = None
        trained = await asyncio.to_thread(engine.fit)
        if trained:
            print("[FinSentinels GNN] Ready; hybrid rule + GNN scoring enabled")
        else:
            print("[FinSentinels GNN] Not trained; rule-based scoring remains active")
    except Exception:
        GNN_ENGINE = None
        GNN_IMPORT_ERROR = "GNN initialization failed; rule-based evidence remains active."
        logger.exception("[FinSentinels GNN] Initialization failed; using rules only")


def _stream_network_members(G, account_id: str) -> set[str]:
    """Return accounts directly linked by transfers or shared device/IP nodes."""
    members = {account_id}
    for source, target, edge in G.edges(data=True):
        if edge.get("edge_type") == "TRANSFER" and account_id in {source, target}:
            other = target if source == account_id else source
            if G.nodes.get(other, {}).get("type") == "account":
                members.add(other)
    for node in G.successors(account_id) if account_id in G else ():
        if G.nodes.get(node, {}).get("type") not in {"device", "ip_address"}:
            continue
        for linked_account in G.predecessors(node):
            if G.nodes.get(linked_account, {}).get("type") == "account":
                members.add(linked_account)
    return members


@app.get("/api/stream/intelligence")
async def stream_intelligence(
    request: Request,
    account_id: str | None = None,
    include_widgets: bool = True,
):
    """Stream transaction events and validated explainable-agent widgets as SSE."""
    async def event_stream():
        try:
            selected_account = account_id.strip().upper() if account_id else None
            yield "event: connected\ndata: " + json.dumps({
                "status": "connected",
                "mode": "graph_intelligence_stream",
                "poll_interval_seconds": 2,
            }) + "\n\n"

            transactions = await asyncio.to_thread(load_transactions)
            seen_ids = {tx["transaction_id"] for tx in transactions}
            G = await asyncio.to_thread(load_graph_data)
            watched_accounts = _stream_network_members(G, selected_account) if selected_account else set()
            if include_widgets:
                graph_accounts = sorted(
                    node_id
                    for node_id, details in G.nodes(data=True)
                    if details.get("type") == "account"
                )
                snapshot_accounts = (
                    [selected_account]
                    if selected_account in graph_accounts
                    else []
                ) if selected_account else graph_accounts
                snapshot_batch_size = 8
                if not snapshot_accounts:
                    yield "event: snapshot\ndata: " + json.dumps(
                        {"account_count": 0, "processed_accounts": 0, "complete": True, "widgets": []},
                        ensure_ascii=False,
                    ) + "\n\n"
                for offset in range(0, len(snapshot_accounts), snapshot_batch_size):
                    account_batch = snapshot_accounts[offset:offset + snapshot_batch_size]
                    snapshot_widgets = await asyncio.to_thread(
                        _agent_snapshot_widgets,
                        G,
                        account_batch,
                    )
                    processed_accounts = offset + len(account_batch)
                    yield "event: snapshot\ndata: " + json.dumps(
                        {
                            "account_count": len(snapshot_accounts),
                            "processed_accounts": processed_accounts,
                            "complete": processed_accounts >= len(snapshot_accounts),
                            "widgets": snapshot_widgets,
                        },
                        ensure_ascii=False,
                    ) + "\n\n"
            initial = transactions[-3:]
            for tx in initial:
                yield "event: transaction\ndata: " + json.dumps(jsonable_encoder(tx), ensure_ascii=False) + "\n\n"

            while not await request.is_disconnected():
                await asyncio.sleep(2)
                latest = load_transactions()
                new_transactions = [tx for tx in latest if tx["transaction_id"] not in seen_ids]
                if not new_transactions:
                    yield ": keep-alive\n\n"
                    continue
                G = load_graph_data()
                if selected_account:
                    watched_accounts = _stream_network_members(G, selected_account)
                for tx in new_transactions:
                    seen_ids.add(tx["transaction_id"])
                    yield "event: transaction\ndata: " + json.dumps(jsonable_encoder(tx), ensure_ascii=False) + "\n\n"
                    if not include_widgets:
                        continue
                    endpoints = {tx["source_account"], tx["target_account"]}
                    if selected_account:
                        subjects = [selected_account] if endpoints & watched_accounts else []
                    else:
                        subjects = [subject for subject in endpoints
                                    if G.nodes.get(subject, {}).get("type") == "account"]
                    for subject in subjects:
                        for widget in _agent_widgets_for_account(G, subject, tx["transaction_id"]):
                            yield "event: widget\ndata: " + json.dumps(widget, ensure_ascii=False) + "\n\n"
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ============================================================
# PROFILE
# ============================================================

@app.get("/api/profile")
def profile():
    try:
        cases = load_cases()

        return {
            "name": "Analyst",
            "role": "Analyst",
            "organization": "FinSentinels",
            "active_cases": sum(
                1
                for c in cases
                if (
                    isinstance(
                        c,
                        dict,
                    )
                    and c.get(
                        "status"
                    )
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


# ============================================================
# SETTINGS
# ============================================================

@app.get("/api/settings")
def read_settings():
    return get_settings()


@app.put("/api/settings")
def update_settings(
    payload: SettingsUpdate,
):
    if (
        payload.watch_threshold
        >= payload.high_threshold
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Watch threshold must be lower "
                "than high-risk threshold"
            ),
        )

    settings = payload.model_dump()

    return save_settings(settings)


# ============================================================
# STARTUP
# ============================================================

@app.on_event("startup")
async def startup():
    """
    Do not create or write bundled seed data on startup. Runtime state is
    kept in the configured data directory, which should be a persistent volume.
    """

    global GNN_ENGINE, GNN_IMPORT_ERROR, GNN_TRANSACTIONS, GNN_TRAINING_TASK
    try:
        RUNTIME_DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    # Keep the synthetic customer preview separate from the analyst graph.
    portal_database_name = "customer-portal-demo.sqlite3" if DATA_MODE == "demo" else "customer-portal-production.sqlite3"
    portal_database_path = Path(os.getenv("FINSENTINELS_PORTAL_DB_PATH", str(RUNTIME_DATA_DIR / portal_database_name))).expanduser()
    try:
        portal_transactions = await asyncio.to_thread(load_transactions if DATA_MODE == "demo" else load_synthetic_transactions)
        audit_chain_valid = await asyncio.to_thread(initialize_portal_store, portal_database_path, portal_transactions)
        if not audit_chain_valid:
            logger.critical("Customer audit hash chain verification failed; new audit entries must be reviewed before production use")
    except Exception:
        logger.exception("Customer portal database could not be initialized")
        raise

    # Never train a production deployment against the bundled synthetic baseline.
    if DATA_MODE == "production":
        GNN_ENGINE = None
        GNN_TRANSACTIONS = []
        GNN_TRAINING_TASK = None
        GNN_IMPORT_ERROR = (
            "GNN disabled in production until a deployment-specific baseline "
            "has been validated. Rule-based evidence remains available."
        )
        print("[FinSentinels GNN] Disabled in production; synthetic training data is not loaded")
        print("FinSentinels API online")
        return

    # Cache the current combined demo dataset for GNN inference. The model is
    # trained only against the demo normal-reference population.
    try:
        GNN_TRANSACTIONS = await asyncio.to_thread(load_transactions)
    except Exception as exc:
        GNN_TRANSACTIONS = []
        print(f"[FinSentinels GNN] Could not load inference transactions: {exc}")

    GNN_TRAINING_TASK = asyncio.create_task(_initialize_gnn_in_background())
    print("[FinSentinels GNN] Initializing in background; rule-based API is ready")

    print("FinSentinels API online")
