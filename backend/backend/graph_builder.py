import json
import os
from datetime import datetime
from typing import Any

import networkx as nx

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def find_data_file() -> str:
    candidates = [
        os.path.join(BASE_DIR, "data", "data", "mock_transactions.json"),
        os.path.join(BASE_DIR, "data", "mock_transactions.json"),
        os.path.join(BASE_DIR, "mock_transactions.json"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(
        "mock_transactions.json not found. Expected data/data/mock_transactions.json"
    )


def load_transactions() -> list[dict[str, Any]]:
    path = find_data_file()
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)

    if not isinstance(data, list):
        raise ValueError("mock_transactions.json must contain a JSON array")

    required = {"transaction_id", "source_account", "target_account", "amount", "timestamp"}
    seen_ids: set[str] = set()
    cleaned: list[dict[str, Any]] = []

    for index, tx in enumerate(data, start=1):
        if not isinstance(tx, dict):
            raise ValueError(f"Transaction #{index} must be a JSON object")

        missing = required - tx.keys()
        if missing:
            raise ValueError(
                f"Transaction #{index} missing required fields: {', '.join(sorted(missing))}"
            )

        tx_id = str(tx["transaction_id"]).strip()
        source = str(tx["source_account"]).strip().upper()
        target = str(tx["target_account"]).strip().upper()

        if not tx_id:
            raise ValueError(f"Transaction #{index} has an empty transaction_id")
        if tx_id in seen_ids:
            raise ValueError(f"Duplicate transaction_id detected: {tx_id}")
        seen_ids.add(tx_id)

        if not source or not target:
            raise ValueError(f"Transaction {tx_id} has an empty account id")
        if source == target:
            raise ValueError(f"Transaction {tx_id} has the same source and target account")

        try:
            amount = float(tx["amount"])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Transaction {tx_id} has an invalid amount") from exc
        if amount < 0:
            raise ValueError(f"Transaction {tx_id} has a negative amount")

        timestamp = str(tx["timestamp"]).strip()
        if timestamp:
            try:
                datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError(f"Transaction {tx_id} has an invalid timestamp") from exc

        cleaned.append(
            {
                **tx,
                "transaction_id": tx_id,
                "source_account": source,
                "target_account": target,
                "amount": amount,
                "timestamp": timestamp,
                "device_id": str(tx.get("device_id", "")).strip() or None,
                "ip_address": str(tx.get("ip_address", "")).strip() or None,
            }
        )

    return cleaned


def _add_unique_device_link(
    G: nx.MultiDiGraph,
    account: str,
    device: str,
    transaction: dict[str, Any],
) -> None:
    key = f"DEVICE:{account}:{device}"
    if G.has_edge(account, device, key=key):
        edge = G[account][device][key]
        edge["transaction_count"] += 1
        edge["transaction_ids"].append(transaction["transaction_id"])
        edge["last_timestamp"] = transaction["timestamp"]
        return

    G.add_edge(
        account,
        device,
        key=key,
        edge_type="USED_DEVICE",
        transaction_id=None,
        transaction_count=1,
        transaction_ids=[transaction["transaction_id"]],
        timestamp=transaction["timestamp"],
        last_timestamp=transaction["timestamp"],
        device_id=device,
        ip_address=transaction.get("ip_address"),
        amount=0.0,
    )


def load_graph_data() -> nx.MultiDiGraph:
    """Build a lossless directed transaction graph.

    Transfer edges use transaction_id as the MultiDiGraph key, so multiple
    transfers between the same pair of accounts remain separate records.
    Device relationships are deduplicated for a cleaner graph while retaining
    transaction_count and transaction_ids on the relationship.
    """
    G = nx.MultiDiGraph()

    for tx in load_transactions():
        source = tx["source_account"]
        target = tx["target_account"]
        device = tx.get("device_id")

        G.add_node(source, type="account")
        G.add_node(target, type="account")

        G.add_edge(
            source,
            target,
            key=tx["transaction_id"],
            edge_type="TRANSFER",
            transaction_id=tx["transaction_id"],
            amount=tx["amount"],
            timestamp=tx["timestamp"],
            device_id=device,
            ip_address=tx.get("ip_address"),
        )

        if device:
            G.add_node(device, type="device")
            _add_unique_device_link(G, source, device, tx)
            _add_unique_device_link(G, target, device, tx)

    return G


def _account_graph(G: nx.MultiDiGraph) -> nx.DiGraph:
    AG = nx.DiGraph()
    accounts = [n for n, d in G.nodes(data=True) if d.get("type") == "account"]
    AG.add_nodes_from(accounts)
    for u, v, data in G.edges(data=True):
        if (
            data.get("edge_type") == "TRANSFER"
            and G.nodes[u].get("type") == "account"
            and G.nodes[v].get("type") == "account"
        ):
            AG.add_edge(u, v)
    return AG


def get_account_transactions(G: nx.MultiDiGraph, account_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if account_id not in G:
        return rows

    for source, target, key, data in G.edges(keys=True, data=True):
        if data.get("edge_type") != "TRANSFER":
            continue
        if source != account_id and target != account_id:
            continue
        rows.append(
            {
                "transaction_id": data.get("transaction_id", key),
                "source": source,
                "target": target,
                "amount": data.get("amount", 0),
                "timestamp": data.get("timestamp"),
                "device_id": data.get("device_id"),
                "ip_address": data.get("ip_address"),
            }
        )

    rows.sort(key=lambda row: row.get("timestamp") or "")
    return rows


def get_shared_devices(G: nx.MultiDiGraph, account_id: str) -> list[dict[str, Any]]:
    result = []
    if account_id not in G:
        return result

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
            rel = G[account_id][device]
            device_edges = [e for e in rel.values() if e.get("edge_type") == "USED_DEVICE"]
            transaction_count = sum(e.get("transaction_count", 0) for e in device_edges)
            result.append(
                {
                    "device_id": device,
                    "accounts": sorted(users),
                    "account_count": len(users),
                    "transaction_count": transaction_count,
                }
            )

    return sorted(result, key=lambda x: x["account_count"], reverse=True)


def get_cycles_for_account(G: nx.MultiDiGraph, account_id: str) -> list[list[str]]:
    AG = _account_graph(G)
    return [cycle for cycle in nx.simple_cycles(AG) if account_id in cycle]


def _risk_factors(G: nx.MultiDiGraph, account_id: str) -> dict[str, int]:
    cycles = get_cycles_for_account(G, account_id)
    transactions = get_account_transactions(G, account_id)
    shared = get_shared_devices(G, account_id)
    AG = _account_graph(G)

    if len(AG) > 1:
        centrality = nx.degree_centrality(AG)
    else:
        centrality = {account_id: 0.0}

    cycle_points = 50 if cycles else 0
    shared_points = min(10 * len(shared), 20)
    velocity_points = 10 if len(transactions) >= 3 else (5 if len(transactions) == 2 else 0)

    degree = AG.degree(account_id) if account_id in AG else 0
    connectivity_points = min(degree * 5, 15)
    centrality_points = min(int(centrality.get(account_id, 0) * 15), 15)

    return {
        "cycle_points": cycle_points,
        "shared_device_points": shared_points,
        "velocity_points": velocity_points,
        "connectivity_points": connectivity_points,
        "centrality_points": centrality_points,
        "cycle_count": len(cycles),
        "shared_device_count": len(shared),
        "transaction_count": len(transactions),
        "degree": degree,
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
        }

    f = _risk_factors(G, account_id)
    score = min(
        10
        + f["cycle_points"]
        + f["shared_device_points"]
        + f["velocity_points"]
        + f["connectivity_points"]
        + f["centrality_points"],
        99,
    )

    reasons = []
    if f["cycle_count"]:
        reasons.append(f"Circular fund routing detected ({f['cycle_count']} cycle(s))")
    if f["shared_device_count"]:
        reasons.append(
            f"Shared device usage detected ({f['shared_device_count']} shared device(s))"
        )
    if f["velocity_points"]:
        reasons.append(f"Elevated transaction velocity ({f['transaction_count']} transactions)")
    if f["connectivity_points"]:
        reasons.append(f"High network connectivity (+{f['connectivity_points']} pts)")
    if f["centrality_points"]:
        reasons.append(f"Network centrality (+{f['centrality_points']} pts)")
    if not reasons:
        reasons.append("No significant suspicious graph indicators detected")

    if score >= 65:
        status = "HIGH RISK"
    elif score >= 35:
        status = "WATCH"
    else:
        status = "SAFE"

    return {
        "account_id": account_id,
        "risk_score": score,
        "status": status,
        "reasons": reasons,
        "factors": {
            "circular_routing": 100 if f["cycle_count"] else 0,
            "device_sharing": min(f["shared_device_count"] * 100, 100),
            "transaction_velocity": min(f["transaction_count"] * 25, 100),
            "network_connectivity": min(
                (f["connectivity_points"] + f["centrality_points"]) * 4, 100
            ),
        },
        "shared_devices": get_shared_devices(G, account_id),
        "transaction_count": f["transaction_count"],
        "cycle_count": f["cycle_count"],
        "degree": f["degree"],
    }


def _serialize_edges(graph: nx.MultiDiGraph) -> list[dict[str, Any]]:
    edges = []
    for u, v, key, data in graph.edges(keys=True, data=True):
        edges.append(
            {
                "id": str(key),
                "source": u,
                "target": v,
                "relation": data.get("edge_type", "LINK"),
                "transaction_id": data.get("transaction_id"),
                "amount": data.get("amount", 0),
                "timestamp": data.get("timestamp"),
                "device_id": data.get("device_id"),
                "ip_address": data.get("ip_address"),
                "transaction_count": data.get("transaction_count", 1),
            }
        )
    return edges


def _serialize_nodes(graph: nx.MultiDiGraph) -> list[dict[str, str]]:
    return [
        {"id": n, "label": n, "type": d.get("type", "account")}
        for n, d in graph.nodes(data=True)
    ]


def get_subgraph(G: nx.MultiDiGraph, target_id: str, depth: int = 2) -> dict[str, Any]:
    target_id = target_id.strip().upper()
    if target_id not in G:
        return {"nodes": [], "edges": []}

    depth = max(1, min(int(depth), 5))
    undirected = G.to_undirected()
    nearby = nx.single_source_shortest_path_length(undirected, target_id, cutoff=depth)
    subgraph = G.subgraph(nearby.keys()).copy()

    return {
        "nodes": _serialize_nodes(subgraph),
        "edges": _serialize_edges(subgraph),
    }


def get_full_graph(G: nx.MultiDiGraph) -> dict[str, Any]:
    return {
        "nodes": _serialize_nodes(G),
        "edges": _serialize_edges(G),
    }
