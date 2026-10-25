from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from threading import Lock
from typing import Any

import networkx as nx

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
MOCK_FILE = os.path.join(DATA_DIR, "mock_transactions.json")
NORMAL_FILE = os.path.join(DATA_DIR, "normal_transactions.json")
DATA_MODE = os.environ.get("FINSENTINELS_DATA_MODE", "demo").strip().lower()
if DATA_MODE not in {"demo", "production"}:
    raise RuntimeError("FINSENTINELS_DATA_MODE must be 'demo' or 'production'.")
_DEFAULT_RUNTIME_DIR = os.path.join(BASE_DIR, "runtime-data") if DATA_MODE == "production" else DATA_DIR
LIVE_FILE = os.path.join(
    os.environ.get("FINSENTINELS_RUNTIME_DIR", _DEFAULT_RUNTIME_DIR),
    "live_transactions.json",
)

REQUIRED_FIELDS = {
    "transaction_id",
    "source_account",
    "target_account",
    "amount",
    "timestamp",
}

# Location-derived country is useful context, but it is not a source/target
# route. Keep it separate so the UI never invents a cross-border transfer.
LOCATION_COUNTRIES = {
    "ahmedabad": "India",
    "bengaluru": "India",
    "chennai": "India",
    "delhi": "India",
    "hyderabad": "India",
    "kolkata": "India",
    "mumbai": "India",
    "pune": "India",
}

_CACHE_LOCK = Lock()
_TRANSACTION_CACHE_SIGNATURE: tuple[tuple[str, int, int], ...] | None = None
_TRANSACTION_CACHE: list[dict[str, Any]] | None = None
_GRAPH_CACHE_SIGNATURE: tuple[tuple[str, int, int], ...] | None = None
_GRAPH_CACHE: nx.MultiDiGraph | None = None


def _source_signature(paths: list[str]) -> tuple[tuple[str, int, int], ...]:
    signature = []
    for path in paths:
        stat = os.stat(path)
        signature.append((path, stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


def _country_from_location(location: Any) -> str | None:
    value = str(location or "").strip()
    if not value:
        return None
    # Accept explicit "City, Country" values from enriched ingestion feeds.
    if "," in value:
        country = value.rsplit(",", 1)[-1].strip()
        if country:
            return country
    return LOCATION_COUNTRIES.get(value.casefold())


def find_data_file() -> str:
    """Return the primary suspicious/mock transaction file for compatibility."""
    if DATA_MODE != "demo":
        raise FileNotFoundError("Bundled demonstration data is disabled in production mode.")
    candidates = [
        MOCK_FILE,
        os.path.join(DATA_DIR, "data", "mock_transactions.json"),
        os.path.join(BASE_DIR, "mock_transactions.json"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(
        "mock_transactions.json not found. Put it in the project's data folder."
    )


def find_data_files() -> list[str]:
    """Return enabled transaction datasets, without mixing demo and live data."""
    files: list[str] = []

    if DATA_MODE == "demo":
        # Synthetic population and scenarios are only available in demo mode.
        if os.path.isfile(NORMAL_FILE):
            files.append(NORMAL_FILE)

        mock = find_data_file()
        if os.path.abspath(mock) not in {os.path.abspath(path) for path in files}:
            files.append(mock)

    # In production, only explicitly ingested transactions are scored.
    if os.path.isfile(LIVE_FILE):
        files.append(LIVE_FILE)

    return files


def _read_json(path: str) -> list[dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        raise
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {os.path.basename(path)}: {exc}") from exc

    if not isinstance(value, list):
        raise ValueError(f"{os.path.basename(path)} must contain a JSON array")
    return value


def _normalize_transaction(index: int, tx: dict[str, Any]) -> dict[str, Any]:
    missing = REQUIRED_FIELDS - tx.keys()
    if missing:
        raise ValueError(
            f"Transaction #{index} missing required fields: {', '.join(sorted(missing))}"
        )

    tx_id = str(tx["transaction_id"]).strip()
    source = str(tx["source_account"]).strip().upper()
    target = str(tx["target_account"]).strip().upper()

    if not tx_id:
        raise ValueError(f"Transaction #{index} has an empty transaction_id")
    if not source or not target:
        raise ValueError(f"Transaction {tx_id} has an empty account id")
    if source == target:
        raise ValueError(f"Transaction {tx_id} cannot transfer to itself")

    try:
        amount = float(tx["amount"])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Transaction {tx_id} has an invalid amount") from exc
    if amount < 0:
        raise ValueError(f"Transaction {tx_id} has a negative amount")

    timestamp = str(tx["timestamp"]).strip()
    try:
        parsed_timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Transaction {tx_id} has an invalid timestamp") from exc
    if parsed_timestamp.tzinfo is None:
        parsed_timestamp = parsed_timestamp.replace(tzinfo=timezone.utc)

    currency = str(tx.get("currency") or "INR").strip().upper()
    try:
        amount_inr = round(float(tx["amount_inr"]), 2) if tx.get("amount_inr") is not None else (round(amount, 2) if currency == "INR" else None)
        instructed_amount = round(float(tx["instructed_amount"]), 2) if tx.get("instructed_amount") is not None else None
        fx_divergence_ratio = float(tx["fx_divergence_ratio"]) if tx.get("fx_divergence_ratio") is not None else None
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Transaction {tx_id} has invalid currency or FX metadata") from exc

    return {
        **tx,
        "transaction_id": tx_id,
        "source_account": source,
        "target_account": target,
        "amount": round(amount, 2),
        "currency": currency,
        "amount_inr": amount_inr,
        "instructed_amount": instructed_amount,
        "instructed_currency": str(tx.get("instructed_currency") or "").strip().upper() or None,
        "fx_divergence_ratio": fx_divergence_ratio,
        "currency_mismatch": bool(tx.get("currency_mismatch") or (
            tx.get("instructed_currency") and str(tx.get("instructed_currency")).strip().upper() != str(tx.get("currency") or "INR").strip().upper()
        )),
        "fx_unconverted": bool(tx.get("fx_unconverted") or (
            str(tx.get("currency") or "INR").strip().upper() != "INR" and tx.get("amount_inr") is None
        )),
        "source_provider": str(tx.get("source_provider") or "").strip() or None,
        "source_event_id": str(tx.get("source_event_id") or "").strip() or None,
        "direction": str(tx.get("direction") or "").strip().upper() or None,
        "timestamp": timestamp,
        "timestamp_dt": parsed_timestamp,
        "device_id": str(tx.get("device_id", "")).strip() or None,
        "ip_address": str(tx.get("ip_address", "")).strip() or None,
        "merchant_id": str(tx.get("merchant_id", "")).strip() or None,
        "location": str(tx.get("location", "")).strip() or None,
        "location_country": str(tx.get("location_country", "")).strip() or _country_from_location(tx.get("location")),
        "source_country": str(tx.get("source_country", "")).strip() or None,
        "target_country": str(tx.get("target_country", "")).strip() or None,
    }


def load_transactions() -> list[dict[str, Any]]:
    """Load and validate enabled transactions.

    Demo mode combines the reference population with synthetic scenarios.
    Production mode reads only explicitly ingested transactions and starts
    empty until a source is connected.
    """
    global _TRANSACTION_CACHE, _TRANSACTION_CACHE_SIGNATURE
    sources = find_data_files()
    signature = _source_signature(sources)
    with _CACHE_LOCK:
        if _TRANSACTION_CACHE is not None and _TRANSACTION_CACHE_SIGNATURE == signature:
            return _TRANSACTION_CACHE

    if not sources:
        if DATA_MODE == "production":
            cleaned: list[dict[str, Any]] = []
        else:
            raise FileNotFoundError("No transaction dataset found in the data folder.")
    else:
        seen_ids: set[str] = set()
        cleaned = []

        for path in sources:
            for index, raw in enumerate(_read_json(path), start=len(cleaned) + 1):
                if not isinstance(raw, dict):
                    raise ValueError(f"Transaction #{index} must be a JSON object")
                tx = _normalize_transaction(index, raw)
                if tx["transaction_id"] in seen_ids:
                    raise ValueError(f"Duplicate transaction_id detected: {tx['transaction_id']}")
                seen_ids.add(tx["transaction_id"])
                cleaned.append(tx)

        cleaned.sort(key=lambda item: (item["timestamp_dt"], item["transaction_id"]))

    # Do not publish a cache entry if an atomic ingest replaced a source while
    # the files were being read. The next call can then rebuild from new data.
    if _source_signature(find_data_files()) == signature:
        with _CACHE_LOCK:
            _TRANSACTION_CACHE = cleaned
            _TRANSACTION_CACHE_SIGNATURE = signature
    return cleaned


def load_synthetic_transactions() -> list[dict[str, Any]]:
    """Load only the bundled synthetic records for isolated customer previews.

    This is deliberately separate from ``load_transactions``: production
    analyst scoring continues to read only explicitly ingested live records.
    """
    sources = [path for path in (NORMAL_FILE, MOCK_FILE) if os.path.isfile(path)]
    seen_ids: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    for path in sources:
        for index, raw in enumerate(_read_json(path), start=len(cleaned) + 1):
            if not isinstance(raw, dict):
                raise ValueError(f"Transaction #{index} must be a JSON object")
            transaction = _normalize_transaction(index, raw)
            if transaction["transaction_id"] in seen_ids:
                raise ValueError(f"Duplicate transaction_id detected: {transaction['transaction_id']}")
            seen_ids.add(transaction["transaction_id"])
            cleaned.append(transaction)
    cleaned.sort(key=lambda item: (item["timestamp_dt"], item["transaction_id"]))
    return cleaned




def _add_device_link(G: nx.MultiDiGraph, account: str, device: str, tx: dict[str, Any]) -> None:
    key = f"DEVICE:{account}:{device}"
    if G.has_edge(account, device, key=key):
        edge = G[account][device][key]
        edge["transaction_count"] += 1
        edge["transaction_ids"].append(tx["transaction_id"])
        edge["last_timestamp"] = tx["timestamp"]
        return

    G.add_edge(
        account,
        device,
        key=key,
        edge_type="USED_DEVICE",
        transaction_id=None,
        transaction_count=1,
        transaction_ids=[tx["transaction_id"]],
        timestamp=tx["timestamp"],
        last_timestamp=tx["timestamp"],
        device_id=device,
        ip_address=tx.get("ip_address"),
        amount=0.0,
    )


def _add_shared_attribute_link(
    G: nx.MultiDiGraph,
    account: str,
    node_id: str,
    edge_type: str,
    tx: dict[str, Any],
) -> None:
    key = f"{edge_type}:{account}:{node_id}"
    if G.has_edge(account, node_id, key=key):
        edge = G[account][node_id][key]
        edge["transaction_count"] += 1
        edge["transaction_ids"].append(tx["transaction_id"])
        edge["last_timestamp"] = tx["timestamp"]
        return

    G.add_edge(
        account,
        node_id,
        key=key,
        edge_type=edge_type,
        transaction_id=None,
        transaction_count=1,
        transaction_ids=[tx["transaction_id"]],
        timestamp=tx["timestamp"],
        last_timestamp=tx["timestamp"],
        amount=0.0,
        device_id=tx.get("device_id"),
        ip_address=tx.get("ip_address"),
    )


def _build_graph() -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    for tx in load_transactions():
        source = tx["source_account"]
        target = tx["target_account"]
        device = tx.get("device_id")
        merchant = tx.get("merchant_id")
        location = tx.get("location")
        ip_address = tx.get("ip_address")

        graph.add_node(source, type="account", **({"label": tx["source_name"]} if tx.get("source_name") else {}))
        graph.add_node(target, type="account", **({"label": tx["target_name"]} if tx.get("target_name") else {}))
        graph.add_edge(
            source,
            target,
            key=tx["transaction_id"],
            edge_type="TRANSFER",
            transaction_id=tx["transaction_id"],
            amount=tx["amount"],
            currency=tx.get("currency", "INR"),
            amount_inr=tx.get("amount_inr"),
            instructed_amount=tx.get("instructed_amount"),
            instructed_currency=tx.get("instructed_currency"),
            fx_divergence_ratio=tx.get("fx_divergence_ratio"),
            currency_mismatch=tx.get("currency_mismatch", False),
            fx_unconverted=tx.get("fx_unconverted", False),
            source_provider=tx.get("source_provider"),
            source_event_id=tx.get("source_event_id"),
            direction=tx.get("direction"),
            timestamp=tx["timestamp"],
            device_id=device,
            ip_address=tx.get("ip_address"),
            merchant_id=merchant,
            location=location,
            location_country=tx.get("location_country"),
            source_country=tx.get("source_country"),
            target_country=tx.get("target_country"),
            source_name=tx.get("source_name"),
            target_name=tx.get("target_name"),
        )

        if device:
            graph.add_node(device, type="device")
            # Transaction telemetry describes the initiating endpoint. Do not
            # attribute the sender's device to the receiving account.
            _add_device_link(graph, source, device, tx)

        if ip_address:
            ip_id = f"IP:{ip_address}"
            graph.add_node(ip_id, type="ip_address", label=ip_address)
            _add_shared_attribute_link(graph, source, ip_id, "USED_IP", tx)

        if merchant:
            graph.add_node(merchant, type="merchant")
            _add_shared_attribute_link(graph, source, merchant, "USED_MERCHANT", tx)
            _add_shared_attribute_link(graph, target, merchant, "USED_MERCHANT", tx)

        if location:
            location_id = f"LOC:{location}"
            graph.add_node(location_id, type="location", label=location)
            _add_shared_attribute_link(graph, source, location_id, "OCCURRED_AT", tx)
            _add_shared_attribute_link(graph, target, location_id, "OCCURRED_AT", tx)

    return graph


def load_graph_data() -> nx.MultiDiGraph:
    """Return the current graph, rebuilding only when an input file changes."""
    global _GRAPH_CACHE, _GRAPH_CACHE_SIGNATURE
    signature = _source_signature(find_data_files())
    with _CACHE_LOCK:
        if _GRAPH_CACHE is not None and _GRAPH_CACHE_SIGNATURE == signature:
            return _GRAPH_CACHE

    graph = _build_graph()
    if _source_signature(find_data_files()) == signature:
        with _CACHE_LOCK:
            _GRAPH_CACHE = graph
            _GRAPH_CACHE_SIGNATURE = signature
    return graph

def invalidate_cache() -> None:
    """Clear transaction and graph caches after a source update."""
    global _GRAPH_CACHE, _GRAPH_CACHE_SIGNATURE
    global _TRANSACTION_CACHE, _TRANSACTION_CACHE_SIGNATURE
    with _CACHE_LOCK:
        _GRAPH_CACHE = None
        _GRAPH_CACHE_SIGNATURE = None
        _TRANSACTION_CACHE = None
        _TRANSACTION_CACHE_SIGNATURE = None


def _account_graph(G: nx.MultiDiGraph) -> nx.DiGraph:
    AG = nx.DiGraph()
    accounts = [n for n, d in G.nodes(data=True) if d.get("type") == "account"]
    AG.add_nodes_from(accounts)
    for u, v, data in G.edges(data=True):
        if data.get("edge_type") == "TRANSFER" and u in AG and v in AG:
            AG.add_edge(u, v)
    return AG


_GRAPH_ANALYSIS_CACHE_KEY = "_fin_sentinels_analysis_context"


def _transaction_row(source: str, target: str, key: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "transaction_id": data.get("transaction_id", key),
        "source": source,
        "target": target,
        "amount": data.get("amount", 0),
        "currency": data.get("currency", "INR"),
        "amount_inr": data.get("amount_inr"),
        "instructed_amount": data.get("instructed_amount"),
        "instructed_currency": data.get("instructed_currency"),
        "fx_divergence_ratio": data.get("fx_divergence_ratio"),
        "currency_mismatch": data.get("currency_mismatch", False),
        "fx_unconverted": data.get("fx_unconverted", False),
        "source_provider": data.get("source_provider"),
        "source_event_id": data.get("source_event_id"),
        "direction": data.get("direction"),
        "timestamp": data.get("timestamp"),
        "device_id": data.get("device_id"),
        "ip_address": data.get("ip_address"),
        "merchant_id": data.get("merchant_id"),
        "location": data.get("location"),
        "location_country": data.get("location_country"),
        "source_country": data.get("source_country"),
        "target_country": data.get("target_country"),
        "source_name": data.get("source_name"),
        "target_name": data.get("target_name"),
    }


def _graph_analysis_context(G: nx.MultiDiGraph) -> dict[str, Any]:
    """Build expensive, graph-wide analysis data once per immutable graph snapshot."""
    cached = G.graph.get(_GRAPH_ANALYSIS_CACHE_KEY)
    if cached is not None:
        return cached

    account_graph = _account_graph(G)
    degree_centrality = (
        nx.degree_centrality(account_graph)
        if len(account_graph) > 1
        else {account_id: 0.0 for account_id in account_graph}
    )
    cycles_by_account: dict[str, list[list[str]]] = defaultdict(list)
    for component in nx.strongly_connected_components(account_graph):
        if len(component) > 1:
            cycle = sorted(component)
            for account_id in component:
                cycles_by_account[account_id].append(cycle)

    transactions_by_account: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source, target, key, data in G.edges(keys=True, data=True):
        if data.get("edge_type") != "TRANSFER":
            continue
        row = _transaction_row(source, target, key, data)
        for account_id in {source, target}:
            if account_id in account_graph:
                transactions_by_account[account_id].append(row)
    for rows in transactions_by_account.values():
        rows.sort(key=lambda row: row.get("timestamp") or "")

    shared_devices_by_account: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for device, details in G.nodes(data=True):
        if details.get("type") != "device":
            continue
        users = {
            source
            for source, _target, _key, edge in G.in_edges(device, keys=True, data=True)
            if edge.get("edge_type") == "USED_DEVICE"
            and G.nodes[source].get("type") == "account"
        }
        if len(users) < 2:
            continue
        for account_id in users:
            transaction_count = sum(
                edge.get("transaction_count", 0)
                for edge in G[account_id][device].values()
                if edge.get("edge_type") == "USED_DEVICE"
            )
            shared_devices_by_account[account_id].append({
                "device_id": device,
                "accounts": sorted(users),
                "account_count": len(users),
                "transaction_count": transaction_count,
            })
    for devices in shared_devices_by_account.values():
        devices.sort(key=lambda item: (-item["account_count"], item["device_id"]))

    context = {
        "account_graph": account_graph,
        "degree_centrality": degree_centrality,
        "cycles_by_account": cycles_by_account,
        "transactions_by_account": transactions_by_account,
        "shared_devices_by_account": shared_devices_by_account,
    }
    G.graph[_GRAPH_ANALYSIS_CACHE_KEY] = context
    return context


def get_account_transactions(G: nx.MultiDiGraph, account_id: str) -> list[dict[str, Any]]:
    account_id = account_id.strip().upper()
    if account_id not in G or G.nodes[account_id].get("type") != "account":
        return []
    context = G.graph.get(_GRAPH_ANALYSIS_CACHE_KEY)
    if context is not None:
        return [dict(row) for row in context["transactions_by_account"].get(account_id, [])]
    rows = []
    for source, target, key, data in G.edges(keys=True, data=True):
        if data.get("edge_type") != "TRANSFER":
            continue
        if source != account_id and target != account_id:
            continue
        rows.append(_transaction_row(source, target, key, data))
    rows.sort(key=lambda row: row.get("timestamp") or "")
    return rows


def get_shared_devices(G: nx.MultiDiGraph, account_id: str) -> list[dict[str, Any]]:
    account_id = account_id.strip().upper()
    if account_id not in G:
        return []
    context = G.graph.get(_GRAPH_ANALYSIS_CACHE_KEY)
    if context is not None:
        return [
            {**device, "accounts": list(device["accounts"])}
            for device in context["shared_devices_by_account"].get(account_id, [])
        ]
    result = []
    for device, data in G.nodes(data=True):
        if data.get("type") != "device":
            continue
        users = {
            source
            for source, _target, _key, edge in G.in_edges(device, keys=True, data=True)
            if edge.get("edge_type") == "USED_DEVICE"
            and G.nodes[source].get("type") == "account"
        }
        if account_id in users and len(users) > 1:
            edge_data = G[account_id][device]
            transaction_count = sum(
                edge.get("transaction_count", 0)
                for edge in edge_data.values()
                if edge.get("edge_type") == "USED_DEVICE"
            )
            result.append({
                "device_id": device,
                "accounts": sorted(users),
                "account_count": len(users),
                "transaction_count": transaction_count,
            })
    return sorted(result, key=lambda item: (-item["account_count"], item["device_id"]))


def _cycle_components(G: nx.MultiDiGraph) -> list[set[str]]:
    AG = _account_graph(G)
    return [set(component) for component in nx.strongly_connected_components(AG) if len(component) > 1]


def get_cycles_for_account(G: nx.MultiDiGraph, account_id: str) -> list[list[str]]:
    account_id = account_id.strip().upper()
    context = G.graph.get(_GRAPH_ANALYSIS_CACHE_KEY)
    if context is not None:
        return [list(cycle) for cycle in context["cycles_by_account"].get(account_id, [])]
    matches = [sorted(component) for component in _cycle_components(G) if account_id in component]
    return matches


def _transaction_velocity_count(transactions: list[dict[str, Any]], window_minutes: int = 60) -> int:
    if not transactions:
        return 0
    parsed = []
    for tx in transactions:
        try:
            parsed.append(datetime.fromisoformat(str(tx["timestamp"]).replace("Z", "+00:00")))
        except (TypeError, ValueError):
            continue
    if len(parsed) < 2:
        return len(parsed)
    parsed.sort()
    max_count = 1
    left = 0
    from datetime import timedelta
    for right in range(len(parsed)):
        while parsed[right] - parsed[left] > timedelta(minutes=window_minutes):
            left += 1
        max_count = max(max_count, right - left + 1)
    return max_count


def _flow_metrics(G: nx.MultiDiGraph, account_id: str) -> dict[str, float | int]:
    tx = get_account_transactions(G, account_id)
    inbound = sum(_risk_amount(row) for row in tx if row["target"] == account_id)
    outbound = sum(_risk_amount(row) for row in tx if row["source"] == account_id)
    total = inbound + outbound
    retention = 0.0 if inbound == 0 else max(0.0, min(1.0, (inbound - outbound) / inbound))
    pass_through = min(inbound, outbound) / max(inbound, 1.0)
    return {
        "inbound": round(inbound, 2),
        "outbound": round(outbound, 2),
        "total": round(total, 2),
        "pass_through_ratio": round(pass_through, 3),
        "retention_ratio": round(retention, 3),
        "velocity_window_count": _transaction_velocity_count(tx),
    }


def _risk_amount(tx: dict[str, Any]) -> float:
    """Return INR-canonical value, excluding foreign values without a reference rate."""
    if tx.get("amount_inr") is not None:
        return max(0.0, float(tx["amount_inr"]))
    if str(tx.get("currency") or "INR").strip().upper() == "INR":
        return max(0.0, float(tx.get("amount") or 0))
    return 0.0


def _risk_factors(G: nx.MultiDiGraph, account_id: str) -> dict[str, Any]:
    context = _graph_analysis_context(G)
    cycles = context["cycles_by_account"].get(account_id, [])
    transactions = context["transactions_by_account"].get(account_id, [])
    shared = context["shared_devices_by_account"].get(account_id, [])
    AG = context["account_graph"]

    degree_centrality = context["degree_centrality"]
    degree = AG.degree(account_id) if account_id in AG else 0
    outbound_transactions = [tx for tx in transactions if tx["source"] == account_id]
    velocity = _transaction_velocity_count(outbound_transactions)
    flows = _flow_metrics(G, account_id)

    cycle_points = 45 if cycles else 0
    shared_device_points = min(12 * len(shared), 24)
    velocity_points = 12 if velocity >= 4 else 8 if velocity == 3 else 4 if velocity == 2 else 0
    connectivity_points = min(degree * 4, 12)
    centrality_points = min(int(degree_centrality.get(account_id, 0) * 15), 15)
    mule_signal = (
        bool(shared)
        and flows["pass_through_ratio"] >= 0.70
        and flows["inbound"] >= 10000
        and flows["outbound"] >= 7000
    )
    mule_points = 12 if mule_signal else 0
    high_value_points = 8 if any(_risk_amount(tx) >= 20000 for tx in transactions) else 0

    return {
        "cycle_points": cycle_points,
        "shared_device_points": shared_device_points,
        "velocity_points": velocity_points,
        "connectivity_points": connectivity_points,
        "centrality_points": centrality_points,
        "mule_points": mule_points,
        "high_value_points": high_value_points,
        "cycle_count": len(cycles),
        "shared_device_count": len(shared),
        "transaction_count": len(transactions),
        "degree": degree,
        "velocity_window_count": velocity,
        "mule_signal": mule_signal,
        "flow_metrics": flows,
    }


def analyze_account(G: nx.MultiDiGraph, account_id: str) -> dict[str, Any]:
    account_id = account_id.strip().upper()
    if account_id not in G or G.nodes[account_id].get("type") != "account":
        return {
            "account_id": account_id,
            "risk_score": 0,
            "status": "NOT FOUND",
            "reasons": ["Account not found in transaction graph"],
            "factors": {},
            "shared_devices": [],
            "transaction_count": 0,
            "cycle_count": 0,
            "mule_account": False,
            "flow_metrics": {},
        }

    f = _risk_factors(G, account_id)
    score = min(
        8
        + f["cycle_points"]
        + f["shared_device_points"]
        + f["velocity_points"]
        + f["connectivity_points"]
        + f["centrality_points"]
        + f["mule_points"]
        + f["high_value_points"],
        99,
    )

    reasons: list[str] = []
    if f["cycle_count"]:
        reasons.append(f"Circular fund routing detected ({f['cycle_count']} cycle(s))")
    if f["shared_device_count"]:
        reasons.append(f"Shared device usage detected ({f['shared_device_count']} shared device(s))")
    if f["mule_signal"]:
        reasons.append("Mule-account pattern detected from high pass-through fund flow")
    if f["velocity_points"]:
        reasons.append(f"Elevated transaction velocity ({f['velocity_window_count']} transactions in a 60-minute window)")
    if f["high_value_points"]:
        reasons.append("High-value transfer activity detected")
    if f["connectivity_points"]:
        reasons.append(f"High network connectivity (+{f['connectivity_points']} pts)")
    if f["centrality_points"]:
        reasons.append(f"Network centrality (+{f['centrality_points']} pts)")
    if not reasons:
        reasons.append("No significant suspicious graph indicators detected")

    status = "HIGH RISK" if score >= 65 else "WATCH" if score >= 35 else "SAFE"

    return {
        "account_id": account_id,
        "risk_score": score,
        "status": status,
        "reasons": reasons,
        "factors": {
            "circular_routing": 100 if f["cycle_count"] else 0,
            "device_sharing": min(f["shared_device_count"] * 100, 100),
            "transaction_velocity": min(f["velocity_window_count"] * 25, 100),
            "network_connectivity": min((f["connectivity_points"] + f["centrality_points"]) * 4, 100),
            "mule_flow": 100 if f["mule_signal"] else 0,
            "high_value_activity": 100 if f["high_value_points"] else 0,
        },
        "factor_points": {
            "circular_routing": f["cycle_points"],
            "shared_devices": f["shared_device_points"],
            "transaction_velocity": f["velocity_points"],
            "network_connectivity": f["connectivity_points"],
            "network_centrality": f["centrality_points"],
            "mule_flow": f["mule_points"],
            "high_value_activity": f["high_value_points"],
        },
        "shared_devices": get_shared_devices(G, account_id),
        "transaction_count": f["transaction_count"],
        "cycle_count": f["cycle_count"],
        "degree": f["degree"],
        "mule_account": bool(f["mule_signal"]),
        "flow_metrics": f["flow_metrics"],
    }


def _serialize_nodes(graph: nx.MultiDiGraph) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for node_id, data in graph.nodes(data=True):
        node_type = data.get("type", "account")
        degree = int(graph.degree(node_id))
        shared_accounts = 0
        if node_type in {"device", "ip_address"}:
            relation_type = "USED_DEVICE" if node_type == "device" else "USED_IP"
            shared_accounts = len({
                source
                for source, _target, _key, edge in graph.in_edges(node_id, keys=True, data=True)
                if edge.get("edge_type") == relation_type
                and graph.nodes[source].get("type") == "account"
            })
        shape_by_type = {
            "account": "circle",
            "device": "rounded-square",
            "merchant": "diamond",
            "location": "triangle",
            "ip_address": "hexagon",
        }
        nodes.append({
            "id": node_id,
            "label": data.get("label", node_id),
            "type": node_type,
            "shape": shape_by_type.get(node_type, "circle"),
            "connection_count": degree,
            "shared_account_count": shared_accounts,
            "is_shared": shared_accounts > 1,
        })
    return nodes


def _serialize_edges(graph: nx.MultiDiGraph) -> list[dict[str, Any]]:
    """Serialize graph edges while collapsing repeated transfers.

    The underlying MultiDiGraph remains lossless; only the API representation
    is compacted for visualization. Multiple TRANSFER edges between the same
    ordered pair become one edge carrying transaction_count, transaction_ids,
    total_amount, max_amount and latest timestamp. Non-transfer relationship
    edges keep their existing relationship identity.
    """
    transfer_groups: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    relationship_edges: list[dict[str, Any]] = []

    for u, v, key, data in graph.edges(keys=True, data=True):
        relation = data.get("edge_type", "LINK")
        if relation == "TRANSFER":
            currency = str(data.get("currency") or "INR").upper()
            group_key = (str(u), str(v), relation, currency)
            row = transfer_groups.get(group_key)
            tx_id = data.get("transaction_id") or str(key)
            amount = float(data.get("amount") or 0)
            timestamp = data.get("timestamp")
            if row is None:
                row = {
                    "id": f"TRANSFER:{u}:{v}:{currency}",
                    "source": u,
                    "target": v,
                    "relation": relation,
                    "transaction_id": tx_id,
                    "transaction_ids": [],
                    "amount": amount,
                    "total_amount": amount,
                    "currency": currency,
                    "amount_inr": data.get("amount_inr"),
                    "total_amount_inr": data.get("amount_inr") or (amount if currency == "INR" else None),
                    "instructed_currency": data.get("instructed_currency"),
                    "currency_mismatch": data.get("currency_mismatch", False),
                    "fx_divergence_ratio": data.get("fx_divergence_ratio"),
                    "max_amount": amount,
                    "timestamp": timestamp,
                    "first_timestamp": timestamp,
                    "last_timestamp": timestamp,
                    "device_id": data.get("device_id"),
                    "ip_address": data.get("ip_address"),
                    "merchant_id": data.get("merchant_id"),
                    "location": data.get("location"),
                    "location_country": data.get("location_country"),
                    "source_country": data.get("source_country"),
                    "target_country": data.get("target_country"),
                    "source_name": data.get("source_name"),
                    "target_name": data.get("target_name"),
                    "transaction_count": 0,
                    "evidence_source": "transaction_feed",
                    "weight": 1,
                }
                transfer_groups[group_key] = row
            row["transaction_ids"].append(tx_id)
            row["transaction_count"] += 1
            row["total_amount"] += amount
            row["max_amount"] = max(row["max_amount"], amount)
            canonical_amount = data.get("amount_inr")
            if canonical_amount is None and currency == "INR":
                canonical_amount = amount
            if canonical_amount is not None:
                row["total_amount_inr"] = float(row["total_amount_inr"] or 0) + float(canonical_amount)
            row["currency_mismatch"] = bool(row["currency_mismatch"] or data.get("currency_mismatch", False))
            row["weight"] = max(1, min(6, row["transaction_count"]))
            if timestamp and (not row["first_timestamp"] or str(timestamp) < str(row["first_timestamp"])):
                row["first_timestamp"] = timestamp
            if timestamp and (not row["timestamp"] or str(timestamp) > str(row["timestamp"])):
                row["timestamp"] = timestamp
                row["last_timestamp"] = timestamp
                row["transaction_id"] = tx_id
            continue

        relationship_edges.append({
            "id": str(key),
            "source": u,
            "target": v,
            "relation": relation,
            "transaction_id": data.get("transaction_id"),
            "transaction_ids": data.get("transaction_ids", []),
            "amount": data.get("amount", 0),
            "total_amount": data.get("amount", 0),
            "currency": data.get("currency", "INR"),
            "amount_inr": data.get("amount_inr"),
            "total_amount_inr": data.get("amount_inr"),
            "max_amount": data.get("amount", 0),
            "timestamp": data.get("timestamp"),
            "first_timestamp": data.get("timestamp"),
            "last_timestamp": data.get("last_timestamp", data.get("timestamp")),
            "device_id": data.get("device_id"),
            "ip_address": data.get("ip_address"),
            "merchant_id": data.get("merchant_id"),
            "location": data.get("location"),
            "transaction_count": data.get("transaction_count", 1),
            "evidence_source": "transaction_feed",
            "weight": 1,
        })

    return list(transfer_groups.values()) + relationship_edges


def get_subgraph(G: nx.MultiDiGraph, target_id: str, depth: int = 2) -> dict[str, Any]:
    target_id = target_id.strip().upper()
    if target_id not in G:
        return {"nodes": [], "edges": []}
    depth = max(1, min(int(depth), 5))
    nearby = nx.single_source_shortest_path_length(G.to_undirected(), target_id, cutoff=depth)
    subgraph = G.subgraph(nearby.keys()).copy()
    return {
        "nodes": _serialize_nodes(subgraph),
        "edges": _serialize_edges(subgraph),
    }


def get_alert_subgraph(G: nx.MultiDiGraph, alert_account_ids: set[str], depth: int = 1) -> dict[str, Any]:
    """Return a compact alert-centric subgraph for visualization.

    Includes alert accounts and their direct relationship neighbors. This keeps
    dense networks readable while preserving all edges among the selected nodes.
    """
    seeds = {str(a).strip().upper() for a in alert_account_ids if str(a).strip()}
    seeds = {a for a in seeds if a in G and G.nodes[a].get("type") == "account"}
    if not seeds:
        return {"nodes": [], "edges": []}

    depth = max(1, min(int(depth), 1))
    undirected = G.to_undirected()
    keep: set[str] = set()
    for seed in seeds:
        nearby = nx.single_source_shortest_path_length(undirected, seed, cutoff=depth)
        keep.update(nearby.keys())

    subgraph = G.subgraph(keep).copy()
    return {
        "nodes": _serialize_nodes(subgraph),
        "edges": _serialize_edges(subgraph),
    }


def get_full_graph(G: nx.MultiDiGraph) -> dict[str, Any]:
    return {
        "nodes": _serialize_nodes(G),
        "edges": _serialize_edges(G),
    }
