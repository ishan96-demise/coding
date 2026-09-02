"""Compatibility data-loading helpers for FinSentinels.

The project uses graph_builder.py as the single source of truth for transaction
validation and graph construction. This module keeps a small, explicit API for
scripts that want raw data-quality information without importing the FastAPI app.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from graph_builder import find_data_file, load_graph_data, load_transactions


def validate_dataset() -> dict[str, Any]:
    transactions = load_transactions()
    graph = load_graph_data()
    account_ids = sorted(
        node for node, data in graph.nodes(data=True) if data.get("type") == "account"
    )
    node_types = Counter(data.get("type", "unknown") for _, data in graph.nodes(data=True))
    return {
        "transaction_count": len(transactions),
        "account_count": len(account_ids),
        "first_account": account_ids[0] if account_ids else None,
        "last_account": account_ids[-1] if account_ids else None,
        "node_types": dict(node_types),
        "graph_nodes": graph.number_of_nodes(),
        "graph_edges": graph.number_of_edges(),
        "data_file": find_data_file(),
    }
