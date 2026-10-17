"""Open Bank Project webhook and REST adapter.

Raw provider payloads are normalized in memory and are never persisted. Only
validated transaction facts and their source identifiers enter the graph.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from threading import Lock
from typing import Any


PROVIDER = "OBP"
FX_SOURCE = "ExchangeRate-API Open Access (daily reference)"
_FX_CACHE: dict[str, dict[str, Any]] = {}
_FX_LOCK = Lock()
_CURRENCY = re.compile(r"^[A-Z]{3}$")


class OBPError(ValueError):
    """Safe, user-facing adapter error; never includes credentials or payloads."""


def status() -> dict[str, Any]:
    has_token = bool(os.getenv("OBP_ACCESS_TOKEN", "").strip())
    has_scope = all(os.getenv(key, "").strip() for key in ("OBP_BANK_ID", "OBP_VIEW_ID", "OBP_ACCOUNT_IDS"))
    has_hmac = len(os.getenv("OBP_WEBHOOK_SECRET", "").strip()) >= 32
    return {
        "provider": PROVIDER,
        "configured": bool(has_token and has_scope and has_hmac),
        "webhook_ready": has_hmac,
        "historical_sync_ready": bool(has_token and has_scope),
        "fx_reference_mode": "daily_reference_rates_with_unconverted_fallback",
    }


def verify_webhook_signature(raw_body: bytes, signature: str | None) -> bool:
    secret = os.getenv("OBP_WEBHOOK_SECRET", "")
    if len(secret) < 32 or not signature:
        return False
    supplied = signature.strip()
    if supplied.lower().startswith("sha256="):
        supplied = supplied.split("=", 1)[1]
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied.lower())


def _api_base() -> str:
    base = os.getenv("OBP_API_BASE_URL", "https://apisandbox.openbankproject.com").strip().rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise OBPError("Provider API URL must use HTTPS.")
    return base


def _api_get(path: str, query: dict[str, str] | None = None) -> Any:
    token = os.getenv("OBP_ACCESS_TOKEN", "").strip()
    if not token:
        raise OBPError("The bank connection is not configured.")
    version = os.getenv("OBP_API_VERSION", "v5.1.0").strip()
    url = f"{_api_base()}/obp/{urllib.parse.quote(version, safe='.')}/{path.lstrip('/')}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "FinSentinels/1.0",
    })
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Do not forward the provider body; it may contain identifying data.
        raise OBPError(f"The bank API returned HTTP {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise OBPError("The bank API could not be reached or returned invalid JSON.") from exc


def _number(value: Any) -> float | None:
    try:
        result = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def _money(value: Any) -> tuple[float | None, str | None]:
    if isinstance(value, dict):
        amount = _number(value.get("value", value.get("amount")))
        currency = value.get("currency") or value.get("currency_code")
    else:
        amount, currency = _number(value), None
    code = str(currency or "").strip().upper() or None
    if code and not _CURRENCY.fullmatch(code):
        code = None
    return amount, code


def _explicit_amount_direction(value: Any) -> str | None:
    raw = value.get("value", value.get("amount")) if isinstance(value, dict) else value
    token = str(raw or "").strip()
    if token.startswith("-"):
        return "OUTGOING"
    if token.startswith("+"):
        return "INCOMING"
    return None


def _fx_rates(base_currency: str) -> dict[str, Any] | None:
    base = base_currency.upper()
    if not _CURRENCY.fullmatch(base):
        return None
    with _FX_LOCK:
        cached = _FX_CACHE.get(base)
        if cached:
            return cached
    url = f"https://open.er-api.com/v6/latest/{urllib.parse.quote(base)}"
    try:
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "FinSentinels/1.0"})
        with urllib.request.urlopen(request, timeout=2.5) as response:
            result = json.loads(response.read().decode("utf-8"))
        if result.get("result") != "success" or not isinstance(result.get("rates"), dict):
            return None
        rates = result["rates"]
        data = {
            "rates": rates,
            "as_of": result.get("time_last_update_utc") or result.get("time_last_update_unix"),
        }
        with _FX_LOCK:
            _FX_CACHE[base] = data
        return data
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def _fx_rate(base: str, quote: str) -> tuple[float | None, str | None]:
    if base.upper() == quote.upper():
        return 1.0, None
    data = _fx_rates(base)
    if not data:
        return None, None
    rate = _number(data["rates"].get(quote.upper()))
    return (rate, str(data.get("as_of")) if data.get("as_of") else None) if rate and rate > 0 else (None, None)


def normalize_transaction(transaction: dict[str, Any], event_id: str | None = None, own_account_id: str | None = None) -> dict[str, Any]:
    """Map provider or supplied event shape to one directed, currency-aware edge."""
    if not isinstance(transaction, dict):
        raise OBPError("Transaction details are missing.")

    details = transaction.get("details") if isinstance(transaction.get("details"), dict) else {}
    if "value" in details:
        settlement_raw = details.get("value")
    else:
        settlement_raw = details.get("amount")
    amount, currency = _money(settlement_raw)
    if amount is None:
        raise OBPError("Transaction amount is missing or invalid.")
    if not currency:
        currency = str(os.getenv("OBP_DEFAULT_CURRENCY", "")).strip().upper() or None
    if not currency or not _CURRENCY.fullmatch(currency):
        raise OBPError("Transaction currency is missing or invalid.")

    flag = str(details.get("credit_debit_indicator") or details.get("creditDebitIndicator") or details.get("direction") or transaction.get("direction") or details.get("type") or "").strip().upper()
    outgoing_values = {"DEBIT", "DEBITED", "OUT", "OUTGOING", "OUTBOUND"}
    incoming_values = {"CREDIT", "CREDITED", "IN", "INCOMING", "INBOUND"}
    flag_direction = "OUTGOING" if flag in outgoing_values else "INCOMING" if flag in incoming_values else None
    signed_direction = _explicit_amount_direction(settlement_raw)
    if flag_direction and signed_direction and flag_direction != signed_direction:
        raise OBPError("Transaction direction conflicts with the signed settlement amount.")
    direction = flag_direction or signed_direction
    if direction is None:
        raise OBPError("Transaction direction is ambiguous; an explicit debit/credit marker or signed amount is required.")

    this_account = transaction.get("this_account") if isinstance(transaction.get("this_account"), dict) else {}
    other_account = transaction.get("other_account") if isinstance(transaction.get("other_account"), dict) else {}
    counterparty = transaction.get("counterparty") if isinstance(transaction.get("counterparty"), dict) else {}
    account_id = str(transaction.get("account_id") or this_account.get("id") or own_account_id or "").strip()
    counterparty_id = str(counterparty.get("account_id") or counterparty.get("id") or other_account.get("id") or "").strip()
    if not account_id or not counterparty_id or account_id == counterparty_id:
        raise OBPError("Both the source account and counterparty account are required.")

    if direction == "OUTGOING":
        source_account, target_account = account_id, counterparty_id
        source_name = this_account.get("holder", {}).get("name") if isinstance(this_account.get("holder"), dict) else transaction.get("account_name")
        target_name = counterparty.get("name") or (other_account.get("holder", {}).get("name") if isinstance(other_account.get("holder"), dict) else None)
    else:
        source_account, target_account = counterparty_id, account_id
        source_name = counterparty.get("name") or (other_account.get("holder", {}).get("name") if isinstance(other_account.get("holder"), dict) else None)
        target_name = this_account.get("holder", {}).get("name") if isinstance(this_account.get("holder"), dict) else transaction.get("account_name")

    instructed_amount, instructed_currency = _money(details.get("instructed_amount"))
    metadata = transaction.get("metadata") if isinstance(transaction.get("metadata"), dict) else {}
    risk_metadata = metadata.get("risk_indicators") if isinstance(metadata.get("risk_indicators"), dict) else {}
    source_country = str(details.get("source_country") or transaction.get("source_country") or "").strip() or None
    target_country = str(details.get("target_country") or transaction.get("target_country") or "").strip() or None
    canonical_currency = os.getenv("FIN_SENTINELS_BASE_CURRENCY", "INR").strip().upper()
    absolute_amount = abs(amount)
    amount_inr: float | None = absolute_amount if currency == canonical_currency else None
    reference_rate: float | None = 1.0 if currency == canonical_currency else None
    rate_as_of: str | None = None
    if amount_inr is None:
        rate, rate_as_of = _fx_rate(currency, canonical_currency)
        if rate is not None:
            reference_rate = rate
            amount_inr = round(absolute_amount * rate, 2)

    mismatch = bool(instructed_currency and instructed_currency != currency)
    divergence: float | None = None
    if mismatch and instructed_amount is not None and instructed_currency:
        rate, divergence_as_of = _fx_rate(instructed_currency, currency)
        if rate is not None:
            expected_settlement = abs(instructed_amount) * rate
            if expected_settlement > 0:
                divergence = round(abs(absolute_amount - expected_settlement) / expected_settlement, 6)
            rate_as_of = rate_as_of or divergence_as_of

    timestamp = details.get("completed") or details.get("posted") or transaction.get("timestamp") or transaction.get("completed") or transaction.get("posted")
    if isinstance(timestamp, dict):
        timestamp = timestamp.get("date")
    if not timestamp:
        raise OBPError("Transaction timestamp is missing.")
    timestamp = str(timestamp).strip()
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise OBPError("Transaction timestamp is not ISO-8601.") from exc

    location = metadata.get("where")
    if isinstance(location, dict):
        location = location.get("where")
    return {
        "transaction_id": str(transaction.get("id") or transaction.get("transaction_id") or "").strip(),
        "source_account": source_account,
        "target_account": target_account,
        "source_name": source_name,
        "target_name": target_name,
        "amount": round(absolute_amount, 2),
        "currency": currency,
        "amount_inr": amount_inr,
        "fx_reference_rate": reference_rate,
        "fx_rate_as_of": rate_as_of,
        "fx_rate_source": FX_SOURCE if reference_rate is not None and currency != canonical_currency else None,
        "instructed_amount": abs(instructed_amount) if instructed_amount is not None else None,
        "instructed_currency": instructed_currency,
        "fx_divergence_ratio": divergence,
        "currency_mismatch": mismatch,
        "direction": direction,
        "timestamp": timestamp,
        "device_id": transaction.get("device_id") or metadata.get("device_fingerprint"),
        "ip_address": transaction.get("ip_address") or metadata.get("ip_address"),
        "merchant_id": transaction.get("merchant_id"),
        "location": location,
        "location_country": details.get("location_country") or transaction.get("location_country"),
        "source_country": source_country,
        "target_country": target_country,
        "source_provider": PROVIDER,
        "source_event_id": event_id,
        "fx_unconverted": currency != canonical_currency and amount_inr is None,
    }


def _unwrap_event(payload: dict[str, Any]) -> tuple[dict[str, Any], str | None, str | None]:
    event_id = str(payload.get("event_id") or "").strip() or None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    transaction = data.get("transaction") if isinstance(data.get("transaction"), dict) else payload.get("transaction")
    account_id = str(data.get("account_id") or payload.get("account_id") or "").strip() or None
    if isinstance(transaction, dict):
        return transaction, event_id, account_id
    # Native OBP callbacks intentionally contain identifiers only. Retrieve
    # the transaction through the account-scoped REST endpoint after callback.
    transaction_id = str(payload.get("transaction_id") or data.get("transaction_id") or "").strip()
    bank_id = str(payload.get("bank_id") or data.get("bank_id") or "").strip()
    account_record = data.get("account") if isinstance(data.get("account"), dict) else {}
    account_id = account_id or str(account_record.get("id", "")).strip() or None
    if not transaction_id or not bank_id or not account_id:
        raise OBPError("The provider event does not include transaction identifiers.")
    view_id = os.getenv("OBP_VIEW_ID", "").strip()
    if not view_id:
        raise OBPError("The bank connection has no authorized transaction view.")
    path = "/".join(urllib.parse.quote(part, safe="") for part in ("banks", bank_id, "accounts", account_id, view_id, "transactions", transaction_id))
    fetched = _api_get(path)
    if isinstance(fetched, dict) and isinstance(fetched.get("transaction"), dict):
        fetched = fetched["transaction"]
    if not isinstance(fetched, dict):
        raise OBPError("The bank API returned no transaction details.")
    return fetched, event_id, account_id


def normalize_event(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise OBPError("The bank event must be a JSON object.")
    transaction, event_id, own_account_id = _unwrap_event(payload)
    details = transaction.get("details") if isinstance(transaction.get("details"), dict) else {}
    if not (transaction.get("timestamp") or details.get("completed") or details.get("posted")) and payload.get("timestamp"):
        transaction = {**transaction, "timestamp": payload["timestamp"]}
    normalized = normalize_transaction(transaction, event_id, own_account_id)
    if not normalized["transaction_id"]:
        raise OBPError("Transaction identifier is missing.")
    return normalized


def _list_transactions(bank_id: str, account_id: str, view_id: str, limit: int, offset: int) -> list[dict[str, Any]]:
    parts = ("banks", bank_id, "accounts", account_id, view_id, "transactions")
    path = "/".join(urllib.parse.quote(part, safe="") for part in parts)
    result = _api_get(path, {"limit": str(limit), "offset": str(offset)})
    rows = result.get("transactions", []) if isinstance(result, dict) else result
    if not isinstance(rows, list):
        raise OBPError("The bank API returned an invalid transaction page.")
    return [item for item in rows if isinstance(item, dict)]


def sync_transactions() -> tuple[list[dict[str, Any]], int]:
    """Poll the configured account ledger with bounded, explicit pagination."""
    banks = os.getenv("OBP_BANK_ID", "").strip()
    view = os.getenv("OBP_VIEW_ID", "").strip()
    account_ids = [value.strip() for value in os.getenv("OBP_ACCOUNT_IDS", "").split(",") if value.strip()]
    if not banks or not view or not account_ids or not os.getenv("OBP_ACCESS_TOKEN", "").strip():
        raise OBPError("The bank connection is not configured for ledger sync.")
    limit = max(1, min(int(os.getenv("OBP_SYNC_PAGE_SIZE", "100")), 500))
    max_pages = max(1, min(int(os.getenv("OBP_SYNC_MAX_PAGES", "10")), 50))
    output: dict[str, dict[str, Any]] = {}
    skipped = 0
    for account_id in account_ids[:100]:
        for page in range(max_pages):
            rows = _list_transactions(banks, account_id, view, limit, page * limit)
            for row in rows:
                transaction = dict(row)
                transaction.setdefault("this_account", {"id": account_id})
                transaction.setdefault("account_id", account_id)
                try:
                    normalized = normalize_transaction(transaction, own_account_id=account_id)
                except OBPError:
                    # Non-transfer entries and records without trustworthy
                    # direction are counted but never fabricated into graph links.
                    skipped += 1
                    continue
                output.setdefault(normalized["transaction_id"], normalized)
                if len(output) >= 5000:
                    break
            if len(output) >= 5000:
                break
            if len(rows) < limit:
                break
    return list(output.values()), skipped
