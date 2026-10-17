"""
FinSentinels - Lightweight PyTorch Graph Risk Engine

This module provides a small GraphSAGE-style graph neural network
without requiring torch-geometric.

It learns graph structure from the normal transaction dataset and
produces an anomaly score for account nodes.

Requirements:
    pip install torch
"""

from __future__ import annotations

import json
import math
import os
import threading
from dataclasses import dataclass, field
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

# This model operates on small account graphs (about 100 nodes in the demo).
# Large BLAS thread pools add more scheduling overhead than compute here and
# can stall the single-worker API during startup or live graph inference.
torch.set_num_threads(1)
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    # PyTorch only permits changing inter-op threads before its first operation.
    pass


@dataclass
class GNNResult:
    account_id: str
    score: int
    confidence: float
    embedding_norm: float
    evidence: list[str]
    feature_deviations: list[dict[str, str | float]] = field(default_factory=list)
    available: bool = True


class GraphSAGEEncoder(nn.Module):
    """
    Small GraphSAGE-style encoder.

    Each node combines:
    - its own features
    - the mean features of neighboring nodes
    """

    def __init__(
        self,
        input_dim: int = 7,
        hidden_dim: int = 16,
        output_dim: int = 8,
    ) -> None:
        super().__init__()

        self.self_layer_1 = nn.Linear(
            input_dim,
            hidden_dim,
        )

        self.neighbor_layer_1 = nn.Linear(
            input_dim,
            hidden_dim,
        )

        self.self_layer_2 = nn.Linear(
            hidden_dim,
            output_dim,
        )

        self.neighbor_layer_2 = nn.Linear(
            hidden_dim,
            output_dim,
        )

    def forward(
        self,
        x: torch.Tensor,
        adjacency: torch.Tensor,
    ) -> torch.Tensor:
        # --------------------------------------------------------
        # Layer 1: mean-neighbor aggregation
        # --------------------------------------------------------

        degree = adjacency.sum(
            dim=1,
            keepdim=True,
        ).clamp(min=1.0)

        neighbor_mean = (
            adjacency @ x
        ) / degree

        hidden = (
            self.self_layer_1(x)
            + self.neighbor_layer_1(
                neighbor_mean
            )
        )

        hidden = F.relu(
            hidden
        )

        # --------------------------------------------------------
        # Layer 2
        # --------------------------------------------------------

        degree_hidden = adjacency.sum(
            dim=1,
            keepdim=True,
        ).clamp(min=1.0)

        neighbor_hidden = (
            adjacency @ hidden
        ) / degree_hidden

        embeddings = (
            self.self_layer_2(
                hidden
            )
            + self.neighbor_layer_2(
                neighbor_hidden
            )
        )

        return F.normalize(
            embeddings,
            p=2,
            dim=1,
        )


class GNNRiskEngine:
    """
    Lightweight graph anomaly detection engine.

    Training data:
        normal_transactions.json

    The model learns the structural characteristics of normal
    account behavior.

    During inference:
        accounts that deviate from the learned normal embedding
        population receive higher anomaly scores.
    """

    def __init__(
        self,
        normal_data_path: str | None = None,
        hidden_dim: int = 16,
        embedding_dim: int = 8,
        epochs: int = 120,
    ) -> None:

        self.normal_data_path = (
            normal_data_path
        )

        self.hidden_dim = hidden_dim
        self.embedding_dim = embedding_dim
        self.epochs = epochs

        # Make local demo runs reproducible across restarts.
        torch.manual_seed(42)
        self.model = GraphSAGEEncoder(
            input_dim=10,
            hidden_dim=hidden_dim,
            output_dim=embedding_dim,
        )

        self.trained = False

        self.reference_mean: (
            torch.Tensor | None
        ) = None

        self.reference_std: (
            torch.Tensor | None
        ) = None

        self.reference_embeddings: (
            torch.Tensor | None
        ) = None
        self.reference_distance_mean: float = 0.0
        self.reference_distance_std: float = 1.0

        self.account_ids: list[str] = []

        self.account_to_index: dict[
            str,
            int,
        ] = {}
        self.reference_account_to_index: dict[str, int] = {}
        self.feature_mean: torch.Tensor | None = None
        self.feature_std: torch.Tensor | None = None
        self._live_cache_lock = threading.Lock()
        self._live_cache_key: tuple[int, int, str] | None = None
        self._live_embeddings: torch.Tensor | None = None
        self._live_features: torch.Tensor | None = None
        self._live_account_to_index: dict[str, int] = {}

    # ============================================================
    # DATA LOADING
    # ============================================================

    @staticmethod
    def _load_transactions(
        path: str,
    ) -> list[dict[str, Any]]:

        with open(
            path,
            "r",
            encoding="utf-8",
        ) as handle:

            data = json.load(
                handle
            )

        if not isinstance(
            data,
            list,
        ):
            raise ValueError(
                f"{path} must contain a JSON array."
            )

        return data

    @staticmethod
    def _normalise_account(
        value: Any,
    ) -> str:

        return str(
            value or ""
        ).strip().upper()

    # ============================================================
    # GRAPH → TENSORS
    # ============================================================

    def _build_graph_tensors(
        self,
        transactions: list[
            dict[str, Any]
        ],
        use_reference_scaler: bool = False,
    ) -> tuple[
        torch.Tensor,
        torch.Tensor,
        list[str],
    ]:

        accounts: set[str] = set()

        for tx in transactions:

            source = self._normalise_account(
                tx.get(
                    "source_account"
                )
            )

            target = self._normalise_account(
                tx.get(
                    "target_account"
                )
            )

            if source:
                accounts.add(
                    source
                )

            if target:
                accounts.add(
                    target
                )

        account_ids = sorted(
            accounts
        )

        if not account_ids:
            raise ValueError(
                "No accounts found in normal transaction data."
            )

        account_to_index = {
            account_id: index
            for index, account_id
            in enumerate(
                account_ids
            )
        }

        node_count = len(
            account_ids
        )

        # --------------------------------------------------------
        # Feature matrix
        #
        # feature 0 = transaction count
        # feature 1 = outgoing volume
        # feature 2 = incoming volume
        # feature 3 = unique transfer counterparties
        # feature 4 = shared-device exposure
        # feature 5 = shared-IP exposure
        # feature 6 = cross-border transfer count
        # feature 7 = settlement/instructed currency mismatch count
        # feature 8 = mean capped FX divergence indicator
        # feature 9 = foreign settlement count without a reference conversion
        # --------------------------------------------------------

        features = torch.zeros(
            (
                node_count,
                10,
            ),
            dtype=torch.float32,
        )

        # Undirected adjacency matrix used for neighborhood
        # aggregation.
        adjacency = torch.zeros(
            (
                node_count,
                node_count,
            ),
            dtype=torch.float32,
        )

        outgoing_volume = [
            0.0
        ] * node_count

        incoming_volume = [
            0.0
        ] * node_count

        transaction_count = [
            0
        ] * node_count

        unique_neighbors: list[
            set[str]
        ] = [
            set()
            for _ in range(
                node_count
            )
        ]
        device_users: dict[str, set[str]] = {}
        ip_users: dict[str, set[str]] = {}
        cross_border_count = [0] * node_count
        currency_mismatch_count = [0] * node_count
        fx_divergence_sum = [0.0] * node_count
        fx_divergence_count = [0] * node_count
        unconverted_foreign_count = [0] * node_count

        # --------------------------------------------------------
        # Aggregate transaction information
        # --------------------------------------------------------

        for tx in transactions:

            source = self._normalise_account(
                tx.get(
                    "source_account"
                )
            )

            target = self._normalise_account(
                tx.get(
                    "target_account"
                )
            )

            if (
                source
                not in account_to_index
                or target
                not in account_to_index
            ):
                continue

            source_index = (
                account_to_index[
                    source
                ]
            )

            target_index = (
                account_to_index[
                    target
                ]
            )

            try:
                base_amount = tx.get("amount_inr")
                if base_amount is None:
                    base_amount = tx.get("amount", 0) if str(tx.get("currency") or "INR").upper() == "INR" else 0
                amount = float(base_amount or 0)
            except (
                TypeError,
                ValueError,
            ):
                amount = 0.0

            outgoing_volume[
                source_index
            ] += amount

            incoming_volume[
                target_index
            ] += amount

            transaction_count[
                source_index
            ] += 1

            transaction_count[
                target_index
            ] += 1

            unique_neighbors[
                source_index
            ].add(
                target
            )

            unique_neighbors[
                target_index
            ].add(
                source
            )

            adjacency[
                source_index,
                target_index,
            ] = 1.0

            adjacency[
                target_index,
                source_index,
            ] = 1.0

            device_id = str(tx.get("device_id") or "").strip()
            ip_address = str(tx.get("ip_address") or "").strip()
            if device_id:
                device_users.setdefault(device_id, set()).add(source)
            if ip_address:
                ip_users.setdefault(ip_address, set()).add(source)
            source_country = str(tx.get("source_country") or "").strip().casefold()
            target_country = str(tx.get("target_country") or "").strip().casefold()
            if source_country and target_country and source_country != target_country:
                cross_border_count[source_index] += 1
                cross_border_count[target_index] += 1

            mismatch = bool(tx.get("currency_mismatch"))
            divergence = tx.get("fx_divergence_ratio")
            has_divergence = divergence is not None
            try:
                divergence_value = min(1.0, max(0.0, float(divergence))) if has_divergence else 0.0
            except (TypeError, ValueError):
                divergence_value = 0.0
                has_divergence = False
            unconverted = bool(tx.get("fx_unconverted"))
            for account_index in (source_index, target_index):
                currency_mismatch_count[account_index] += int(mismatch)
                fx_divergence_sum[account_index] += divergence_value
                fx_divergence_count[account_index] += int(has_divergence)
                unconverted_foreign_count[account_index] += int(unconverted)

        shared_device_count = [0] * node_count
        shared_ip_count = [0] * node_count
        for users in device_users.values():
            if len(users) < 2:
                continue
            indices = [account_to_index[user] for user in users]
            for index in indices:
                shared_device_count[index] += 1
            for left, index in enumerate(indices):
                for neighbor in indices[left + 1:]:
                    adjacency[index, neighbor] = 1.0
                    adjacency[neighbor, index] = 1.0
        for users in ip_users.values():
            if len(users) < 2:
                continue
            indices = [account_to_index[user] for user in users]
            for index in indices:
                shared_ip_count[index] += 1
            for left, index in enumerate(indices):
                for neighbor in indices[left + 1:]:
                    adjacency[index, neighbor] = 1.0
                    adjacency[neighbor, index] = 1.0

        # --------------------------------------------------------
        # Create node features
        # --------------------------------------------------------

        for index in range(
            node_count
        ):

            features[
                index,
                0,
            ] = math.log1p(
                transaction_count[
                    index
                ]
            )

            features[
                index,
                1,
            ] = math.log1p(
                outgoing_volume[
                    index
                ]
            )

            features[
                index,
                2,
            ] = math.log1p(
                incoming_volume[
                    index
                ]
            )

            features[
                index,
                3,
            ] = float(
                len(
                    unique_neighbors[
                        index
                    ]
                )
            )

            features[index, 4] = float(shared_device_count[index])
            features[index, 5] = float(shared_ip_count[index])
            features[index, 6] = math.log1p(cross_border_count[index])
            features[index, 7] = math.log1p(currency_mismatch_count[index])
            mean_divergence = fx_divergence_sum[index] / max(1, fx_divergence_count[index])
            features[index, 8] = mean_divergence
            features[index, 9] = math.log1p(unconverted_foreign_count[index])

        # --------------------------------------------------------
        # Standardize features
        # --------------------------------------------------------

        batch_mean = features.mean(
            dim=0,
            keepdim=True,
        )

        batch_std = features.std(
            dim=0,
            keepdim=True,
        ).clamp(
            min=0.1
        )

        if use_reference_scaler and self.feature_mean is not None and self.feature_std is not None:
            mean, std = self.feature_mean, self.feature_std
        else:
            mean, std = batch_mean, batch_std
            self.feature_mean = mean.detach().clone()
            self.feature_std = std.detach().clone()

        features = (
            features - mean
        ) / std

        self.account_ids = (
            account_ids
        )

        self.account_to_index = (
            account_to_index
        )

        return (
            features,
            adjacency,
            account_ids,
        )

    # ============================================================
    # TRAINING
    # ============================================================

    def _train(
        self,
        features: torch.Tensor,
        adjacency: torch.Tensor,
    ) -> torch.Tensor:

        optimizer = torch.optim.Adam(
            self.model.parameters(),
            lr=0.01,
            weight_decay=1e-4,
        )

        # We want connected nodes to receive similar embeddings.
        # Self-connections are included so each node also preserves
        # its own representation.
        target_similarity = (
            adjacency.clone()
        )

        identity = torch.eye(
            adjacency.size(0),
            dtype=torch.float32,
        )

        target_similarity = (
            target_similarity
            + identity
        )

        for epoch in range(
            max(
                1,
                self.epochs,
            )
        ):

            self.model.train()

            optimizer.zero_grad()

            embeddings = self.model(
                features,
                adjacency,
            )

            similarity = (
                embeddings
                @ embeddings.T
            )

            loss = F.mse_loss(
                similarity,
                target_similarity,
            )

            loss.backward()

            optimizer.step()

        self.model.eval()

        with torch.no_grad():

            embeddings = self.model(
                features,
                adjacency,
            )

        return embeddings

    # ============================================================
    # FIT
    # ============================================================

    def fit(self) -> bool:
        """
        Train the GNN using normal transaction data.
        """

        if not self.normal_data_path:
            print(
                "[FinSentinels GNN] No training file configured."
            )

            return False

        if not os.path.isfile(
            self.normal_data_path
        ):
            print(
                "[FinSentinels GNN] Training file not found:",
                self.normal_data_path,
            )

            return False

        transactions = (
            self._load_transactions(
                self.normal_data_path
            )
        )

        if not transactions:
            print(
                "[FinSentinels GNN] Training dataset is empty."
            )

            return False

        (
            features,
            adjacency,
            _,
        ) = self._build_graph_tensors(
            transactions
        )

        embeddings = self._train(
            features,
            adjacency,
        )

        self.reference_embeddings = (
            embeddings.detach()
        )
        self.reference_account_to_index = dict(self.account_to_index)

        self.reference_mean = (
            embeddings.mean(
                dim=0
            ).detach()
        )
        baseline_distances = torch.norm(
            embeddings - self.reference_mean, dim=1
        )
        self.reference_distance_mean = float(baseline_distances.mean().item())
        self.reference_distance_std = max(
            float(baseline_distances.std(unbiased=False).item()), 1e-4
        )

        self.reference_std = (
            embeddings.std(
                dim=0
            ).clamp(
                min=1e-4
            ).detach()
        )

        self.trained = True

        print(
            "[FinSentinels GNN] Model trained:",
            len(
                self.account_ids
            ),
            "accounts",
        )

        return True

    def _live_graph_embeddings(
        self,
        transactions: list[dict[str, Any]],
    ) -> tuple[torch.Tensor, torch.Tensor, dict[str, int]]:
        last_id = str(transactions[-1].get("transaction_id", "")) if transactions else ""
        cache_key = (id(transactions), len(transactions), last_id)
        with self._live_cache_lock:
            if (self._live_cache_key == cache_key and self._live_embeddings is not None
                    and self._live_features is not None):
                return self._live_embeddings, self._live_features, self._live_account_to_index

            features, adjacency, _account_ids = self._build_graph_tensors(
                transactions,
                use_reference_scaler=True,
            )
            account_to_index = dict(self.account_to_index)
            self.model.eval()
            with torch.no_grad():
                embeddings = self.model(features, adjacency).detach()
            self._live_cache_key = cache_key
            self._live_embeddings = embeddings
            self._live_features = features.detach()
            self._live_account_to_index = account_to_index
            return embeddings, self._live_features, account_to_index

    # ============================================================
    # ACCOUNT SCORING
    # ============================================================

    def score_account(
        self,
        account_id: str,
        transactions: list[dict[str, Any]] | None = None,
    ) -> GNNResult:

        normalized = (
            self._normalise_account(
                account_id
            )
        )

        # --------------------------------------------------------
        # Model unavailable
        # --------------------------------------------------------

        if not self.trained:

            return GNNResult(
                account_id=normalized,
                score=0,
                confidence=0.0,
                embedding_norm=0.0,
                evidence=[
                    "GNN model is not trained; NetworkX graph heuristics remain active."
                ],
                available=False,
            )

        # --------------------------------------------------------
        # If current transactions are supplied, embed the live graph too.
        # This is important for newly observed accounts (including synthetic
        # fraud-ring accounts) that were not present in the normal baseline.
        embeddings = self.reference_embeddings
        input_features: torch.Tensor | None = None
        account_to_index = self.reference_account_to_index or self.account_to_index
        if transactions is not None:
            try:
                embeddings, input_features, account_to_index = self._live_graph_embeddings(transactions)
            except (ValueError, RuntimeError) as exc:
                return GNNResult(
                    account_id=normalized, score=0, confidence=0.0,
                    embedding_norm=0.0,
                    evidence=[f"GNN inference unavailable for live graph: {exc}"],
                    available=False,
                )

        # Unknown account
        # --------------------------------------------------------
        if normalized not in account_to_index:
            return GNNResult(
                account_id=normalized, score=0, confidence=0.0,
                embedding_norm=0.0,
                evidence=["Account was not present in the current graph."],
                available=False,
            )

        index = account_to_index[normalized]

        reference_mean = (
            self.reference_mean
        )

        if (
            embeddings is None
            or reference_mean is None
        ):
            return GNNResult(
                account_id=normalized,
                score=0,
                confidence=0.0,
                embedding_norm=0.0,
                evidence=[
                    "GNN reference embeddings are unavailable."
                ],
                available=False,
            )

        embedding = (
            embeddings[index]
        )

        # --------------------------------------------------------
        # Distance from normal embedding population
        # --------------------------------------------------------

        distance = torch.norm(
            embedding
            - reference_mean
        ).item()

        embedding_norm = (
            torch.norm(
                embedding
            ).item()
        )

        # --------------------------------------------------------
        # Convert anomaly distance → 0-100
        # --------------------------------------------------------

        # Calibrate the anomaly ranking against the distance distribution seen
        # during normal-only training. This avoids assigning nearly identical
        # high scores to every unit-normalized embedding. It is not a fraud
        # probability because this model is trained without fraud labels.
        z_score = (distance - self.reference_distance_mean) / max(
            self.reference_distance_std, 1e-4
        )
        anomaly_rank = 1.0 / (1.0 + math.exp(-max(-20.0, min(20.0, (z_score - 1.5) * 1.5))))
        score = int(max(0, min(100, round(anomaly_rank * 100))))
        confidence = max(0.0, min(1.0, 1.0 - math.exp(-max(z_score, 0.0) / 2.0)))

        evidence: list[
            str
        ] = []

        if score >= 70:

            evidence.append(
                "GNN embedding shows significant deviation in transfer topology, shared device/IP exposure, or cross-border behavior."
            )

        elif score >= 40:

            evidence.append(
                "GNN embedding shows moderate deviation in transfer topology, shared device/IP exposure, or cross-border behavior."
            )

        else:

            evidence.append(
                "GNN embedding is close to the learned normal transfer and infrastructure pattern."
            )

        feature_labels = (
            "Transaction count",
            "Outgoing volume",
            "Incoming volume",
            "Unique counterparties",
            "Shared device exposure",
            "Shared IP exposure",
            "Cross-border activity",
            "Currency mismatch count",
            "Mean FX divergence indicator",
            "Unconverted foreign transactions",
        )
        feature_deviations: list[dict[str, str | float]] = []
        if input_features is not None:
            row = input_features[index]
            ranked = sorted(
                ((abs(float(row[feature_index].item())), feature_index, float(row[feature_index].item()))
                 for feature_index in range(min(len(feature_labels), row.numel()))),
                reverse=True,
            )
            feature_deviations = [
                {
                    "feature": feature_labels[feature_index],
                    "z_score": round(value, 2),
                    "direction": "above baseline" if value >= 0 else "below baseline",
                }
                for magnitude, feature_index, value in ranked[:4]
                if magnitude >= 0.75
            ]
            evidence.extend(
                f"{item['feature']} is {abs(float(item['z_score'])):.1f} standard deviations {item['direction']}."
                for item in feature_deviations[:2]
            )

        return GNNResult(
            account_id=normalized,
            score=score,
            confidence=confidence,
            embedding_norm=embedding_norm,
            evidence=evidence,
            feature_deviations=feature_deviations,
        )


def create_engine(
    base_dir: str,
) -> GNNRiskEngine:
    """
    Create a GNN engine using:

        <project>/data/normal_transactions.json
    """

    training_file = os.path.join(
        base_dir,
        "data",
        "normal_transactions.json",
    )

    return GNNRiskEngine(
        normal_data_path=training_file,
    )
