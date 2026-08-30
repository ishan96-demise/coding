# FinSentinels API Reference

## Health

`GET /api/health`

Returns service and loaded graph counts.

`GET /api/data-quality`

Returns transaction count, duplicate-ID count and account count.

## Investigation

`GET /api/score/{account_id}`

Returns risk score, status, reasons, factors, shared devices, transactions, local graph and active settings.

`GET /api/graph/{account_id}`

Returns a depth-limited investigation subgraph.

`GET /api/transaction/{account_id}`

Compatibility alias for the account graph route.

## Full network

`GET /api/network`

Returns the complete typed graph used by the network view.

`GET /api/accounts`

Returns account-level summaries for all accounts.

`GET /api/transactions/recent?limit=20`

Returns the newest transactions for the live transaction feed.

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

Adds evidence and automatically appends a timeline event.

## Profile / settings

`GET /api/profile`

Returns analyst profile and case counts.

`GET /api/settings`

Returns risk thresholds and graph depth.

`PUT /api/settings`

Updates risk thresholds and graph depth.

## Ingestion contract

`POST /api/ingest`

Accepts a validated batch of transaction records. The current MVP returns the validated batch without pretending it is persistent streaming infrastructure. This provides a clean integration point for future queue-based ingestion.
