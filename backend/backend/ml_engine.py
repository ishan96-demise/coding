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
from dataclasses import dataclass
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GNNResult:
    account_id: str
    score: int
    confidence: float
    embedding_norm: float
    evidence: list[str]


class GraphSAGEEncoder(nn.Module):
    """
    Small GraphSAGE-style encoder.

    Each node combines:
    - its own features
    - the mean features of neighboring nodes
    """

    def __init__(
        self,
        input_dim: int = 4,
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

        self.model = GraphSAGEEncoder(
            input_dim=4,
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

        self.account_ids: list[str] = []

        self.account_to_index: dict[
            str,
            int,
        ] = {}

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
        # feature 3 = unique neighbors
        # --------------------------------------------------------

        features = torch.zeros(
            (
                node_count,
                4,
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
                amount = float(
                    tx.get(
                        "amount",
                        0,
                    )
                    or 0
                )
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

        # --------------------------------------------------------
        # Standardize features
        # --------------------------------------------------------

        mean = features.mean(
            dim=0,
            keepdim=True,
        )

        std = features.std(
            dim=0,
            keepdim=True,
        ).clamp(
            min=1e-6
        )

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

        self.reference_mean = (
            embeddings.mean(
                dim=0
            ).detach()
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

    # ============================================================
    # ACCOUNT SCORING
    # ============================================================

    def score_account(
        self,
        account_id: str,
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
            )

        # --------------------------------------------------------
        # Unknown account
        # --------------------------------------------------------

        if (
            normalized
            not in self.account_to_index
        ):

            return GNNResult(
                account_id=normalized,
                score=0,
                confidence=0.0,
                embedding_norm=0.0,
                evidence=[
                    "Account was not present in the normal training graph."
                ],
            )

        index = (
            self.account_to_index[
                normalized
            ]
        )

        embeddings = (
            self.reference_embeddings
        )

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

        anomaly_probability = (
            1.0
            - math.exp(
                -max(
                    distance,
                    0.0,
                )
            )
        )

        score = int(
            max(
                0,
                min(
                    100,
                    round(
                        anomaly_probability
                        * 100
                    ),
                ),
            )
        )

        confidence = max(
            0.0,
            min(
                1.0,
                1.0
                - math.exp(
                    -max(
                        distance,
                        0.0,
                    )
                    / 2.0
                ),
            ),
        )

        evidence: list[
            str
        ] = []

        if score >= 70:

            evidence.append(
                "GNN embedding shows significant structural deviation from normal graph behavior."
            )

        elif score >= 40:

            evidence.append(
                "GNN embedding shows moderate structural deviation from normal graph behavior."
            )

        else:

            evidence.append(
                "GNN embedding is close to the learned normal graph population."
            )

        return GNNResult(
            account_id=normalized,
            score=score,
            confidence=confidence,
            embedding_norm=embedding_norm,
            evidence=evidence,
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