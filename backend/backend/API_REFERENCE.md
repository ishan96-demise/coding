# FinSentinels API Reference

## Health

`GET /api/health`

Returns service and loaded graph counts from the combined normal + mock transaction dataset.

`GET /api/data-quality`

Returns combined transaction count, duplicate-ID count and account count.

## Investigation

`GET /api/score/{account_id}`

Returns the linked-network risk score (0–100), risk band, account-level signal, explainable score components, linked account cohort, GNN evidence, transactions, IP/device/geographic evidence, local graph and active settings. `risk_score` is the network score used by search, alerts and cases.

`GET /api/graph/{account_id}`

Returns a depth-limited investigation subgraph. Pass `?depth=1` for direct transaction, device, and IP neighbors or a larger depth (up to 5) to expand the neighborhood. If omitted, the configured graph depth is used.

`GET /api/transaction/{account_id}`

Compatibility alias for the account graph route.

## Full network

`GET /api/network`

Returns the complete typed graph used by the network view.

`GET /api/intelligence`

Returns a nationwide snapshot over the transaction data currently loaded by this instance, including aggregate network risk, account and transaction counts, shared infrastructure and observed countries.

`GET /api/accounts`

Returns linked-network risk scores and risk bands for each account investigation target.

`GET /api/transactions/recent?limit=20`

Returns the newest transactions for the live transaction feed.

`GET /api/stream/intelligence?account_id=ACC_097&include_widgets=true`

Server-Sent Events stream. Emits `connected` on connection, `transaction` for recent/new feed records, and `widget` for structured explainable graph-analysis output. `account_id` seeds the stream with that account's current analysis and follows new activity touching its directly linked transaction/device/IP network. Set `include_widgets=false` for transaction events only. The client should reconnect automatically if the connection drops. The current widget producers are deterministic graph, network-risk, and account-behavior analyses; no external LLM provider is configured.

Widget event data follows this shape:

```json
{
  "event_id": "ACC_097:network-risk",
  "agent": "Network Risk Agent",
  "widget_type": "risk_summary",
  "subject": "ACC_097",
  "score": 99,
  "risk_level": "HIGH RISK",
  "confidence": 0.82,
  "rationale": "Explainable summary of the linked network signals.",
  "evidence": ["shared device", "cross-border route"],
  "score_components": {
    "network": {
      "highest_linked_account_signal": 82,
      "linked_network_bonus": 16,
      "coordinated_signal_present": true,
      "shared_ip_bonus": 8,
      "cross_border_context_bonus": 5
    }
  },
  "timestamp": "2026-10-16T10:30:00+05:30"
}
```

`POST /api/ingest`

Accepts a batch of new records, persists them to the live transaction feed, and rebuilds graph intelligence immediately. Existing transaction IDs are rejected with HTTP 409. Send transaction records with `transaction_id`, `source_account`, `target_account`, `amount`, `timestamp`, and optional `source_name`, `target_name`, `device_id`, `ip_address`, `merchant_id`, `location`, `location_country`, `source_country`, and `target_country`. A location-derived country identifies where an event was observed; a sender-to-recipient route is shown only when both endpoint country fields are supplied.

Example:

```json
{
  "transactions": [{
    "transaction_id": "BANK-2026-0001",
    "source_account": "ACC_065",
    "target_account": "ACC_032",
    "source_name": "Sarthak",
    "target_name": "Ishan",
    "amount": 5000,
    "timestamp": "2026-10-16T10:30:00+05:30",
    "device_id": "DEVICE-18",
    "ip_address": "203.0.113.18",
    "source_country": "India",
    "target_country": "Germany"
  }]
}
```

## Alerts

`GET /api/alerts`

Returns accounts classified `HIGH RISK` or `WATCH`.

## Analytics

`GET /api/analytics`

Returns network counts, risk distribution, fraud patterns, transaction metrics, case metrics and shared-device details.

## Cases

`GET /api/cases`

Returns all cases.

`POST /api/cases`

Create a case from an account ID, priority and analyst note.

`GET /api/cases/{case_id}`

Returns the case plus current analysis, evidence and timeline.

`PATCH /api/cases/{case_id}`

Update status, priority or note.

Allowed statuses:

- OPEN
- INVESTIGATING
- CLOSED
- DISMISSED

`POST /api/cases/{case_id}/evidence`

Adds analyst evidence and automatically appends a timeline event. The request may include `transaction_ids` (up to 100); every referenced ID must already exist in the loaded transaction records. IDs are stored as structured references instead of being embedded in the description.

```json
{
  "evidence_type": "Transaction review",
  "description": "Rapid pass-through observed across the account.",
  "transaction_ids": ["replace-with-an-existing-transaction-id"]
}
```

Replace the example ID with a value from `GET /api/transactions/recent`. Provide a non-empty description, at least one known transaction ID, or both.

## Profile / settings

`GET /api/profile`

Returns analyst profile and case counts.

`GET /api/settings`

Returns risk thresholds and graph depth.

`PUT /api/settings`

Updates risk thresholds and graph depth.

## Ingestion contract

`POST /api/ingest`

Accepts a validated batch, persists it to the live feed, and immediately includes it in graph intelligence. An external bank or processor adapter must push events to this API; no external provider credentials are bundled with the project.
