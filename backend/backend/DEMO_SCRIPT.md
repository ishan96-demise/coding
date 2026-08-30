# FinSentinels — 5 Minute Judge Demo

## 0:00 — Problem

“Traditional fraud systems often score transactions independently. FinSentinels adds the missing relationship context by modelling transactions as a network.”

## 0:30 — Overview

Show the populated dashboard.

Point out:
- 99 accounts
- 376 transactions
- flagged population
- fraud rings
- shared devices
- transaction volume

## 1:00 — Network

Open Transaction Network.

Use the filters to show the fraud-ring and mule views.

Say:

“Accounts are blue, high-risk accounts are red, devices are amber, merchants are purple and locations are blue triangles. The system can therefore reason over relationships, not just rows.”

## 1:45 — Investigation

Investigate `ACC_097`.

Explain:
- high risk score
- circular routing
- shared infrastructure
- velocity / connectivity evidence
- nearby graph context

## 2:30 — Case workflow

Click **Create Case**.

Open Cases.

Click the new case.

Show:
- risk score
- evidence
- timeline
- status

Add one evidence record.

Move status to `INVESTIGATING`, then `CLOSED`.

Say:

“The platform moves from detection to an auditable investigator workflow rather than stopping at an alert.”

## 3:45 — Analytics

Show:
- risk distribution
- cycle count
- mule accounts
- shared devices
- transaction volume
- case status counts

## 4:20 — Technical defense

“Today’s MVP uses explainable NetworkX graph heuristics because we wanted every decision to be demonstrable. The graph is a typed knowledge graph, and the backend exposes a clean ingestion contract. Phase 2 adds Node2Vec-style embeddings and GraphSAGE/GNN scoring without changing the investigator workflow.”

## 4:50 — Close

“FinSentinels gives investigators the relationship context behind suspicious activity, an explainable score, and a case-management workflow in one system.”
