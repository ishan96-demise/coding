"""Customer portal persistence and access-scoped queries.

SQLite is used for local development. SQL and the persistence boundary live in
this module so a production DB adapter can replace it without changing routes.
All portal transaction reads require a user id and are constrained to that
user's linked account ids.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SESSION_COOKIE_NAME = "fin_customer_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 14
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 8
_DB_PATH: Path | None = None
_AUDIT_ZERO_HASH = "0" * 64
_AUDIT_CHAIN_VALID: bool | None = None


def _audit_entry_hash(entry: dict[str, Any] | sqlite3.Row, previous_hash: str) -> str:
    canonical = json.dumps(
        {
            "id": int(entry["id"]),
            "user_id": int(entry["user_id"]),
            "action": str(entry["action"]),
            "resource_type": str(entry["resource_type"]),
            "resource_id": entry["resource_id"],
            "occurred_at": str(entry["occurred_at"]),
            "previous_hash": previous_hash,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class _ClosingConnection(sqlite3.Connection):
    """Close the connection when the normal SQLite context manager exits."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class PortalRateLimitError(Exception):
    """Raised after the customer login limit is exceeded."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat(timespec="seconds").replace("+00:00", "Z")


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _password_record(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return salt.hex(), digest.hex()


def _connect() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("Customer database is not initialized")
    connection = sqlite3.connect(_DB_PATH, timeout=15, isolation_level=None, factory=_ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    return connection


def initialize_portal_store(database_path: Path, transactions: list[dict[str, Any]]) -> bool:
    """Create the local schema and seed the customer view from the graph data."""
    global _DB_PATH, _AUDIT_CHAIN_VALID
    _DB_PATH = database_path.resolve()
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with _connect() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','analyst','admin')),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS accounts (
                account_id TEXT PRIMARY KEY,
                currency TEXT NOT NULL DEFAULT 'INR',
                opening_balance REAL NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS linked_accounts (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                account_id TEXT NOT NULL REFERENCES accounts(account_id),
                linked_at TEXT NOT NULL,
                PRIMARY KEY (user_id, account_id),
                UNIQUE (account_id)
            );
            CREATE INDEX IF NOT EXISTS ix_linked_accounts_user ON linked_accounts(user_id);
            CREATE TABLE IF NOT EXISTS transactions (
                transaction_id TEXT PRIMARY KEY,
                source_account TEXT NOT NULL REFERENCES accounts(account_id),
                target_account TEXT NOT NULL REFERENCES accounts(account_id),
                amount REAL NOT NULL,
                amount_inr REAL,
                currency TEXT NOT NULL DEFAULT 'INR',
                timestamp TEXT NOT NULL,
                status TEXT NOT NULL,
                merchant_id TEXT,
                location TEXT,
                source_provider TEXT
            );
            CREATE INDEX IF NOT EXISTS ix_transactions_source_time ON transactions(source_account, timestamp DESC);
            CREATE INDEX IF NOT EXISTS ix_transactions_target_time ON transactions(target_account, timestamp DESC);
            CREATE TABLE IF NOT EXISTS cases (
                case_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                account_id TEXT NOT NULL,
                transaction_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'OPEN',
                priority TEXT NOT NULL DEFAULT 'HIGH',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE (user_id, transaction_id)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                action TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                resource_id TEXT,
                occurred_at TEXT NOT NULL,
                previous_hash TEXT NOT NULL DEFAULT '',
                entry_hash TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS ix_audit_user_time ON audit_log(user_id, occurred_at DESC);
            CREATE TABLE IF NOT EXISTS login_attempts (
                source_hash TEXT PRIMARY KEY,
                window_started_at TEXT NOT NULL,
                attempt_count INTEGER NOT NULL
            );
            """
        )

        audit_columns = {str(row["name"]) for row in connection.execute("PRAGMA table_info(audit_log)").fetchall()}
        needs_audit_chain_migration = "previous_hash" not in audit_columns and "entry_hash" not in audit_columns
        if "previous_hash" not in audit_columns:
            connection.execute("ALTER TABLE audit_log ADD COLUMN previous_hash TEXT NOT NULL DEFAULT ''")
        if "entry_hash" not in audit_columns:
            connection.execute("ALTER TABLE audit_log ADD COLUMN entry_hash TEXT NOT NULL DEFAULT ''")
        if needs_audit_chain_migration:
            previous_hash = _AUDIT_ZERO_HASH
            legacy_rows = connection.execute(
                "SELECT id,user_id,action,resource_type,resource_id,occurred_at FROM audit_log ORDER BY id"
            ).fetchall()
            for row in legacy_rows:
                entry = dict(row)
                entry_hash = _audit_entry_hash(entry, previous_hash)
                connection.execute(
                    "UPDATE audit_log SET previous_hash=?,entry_hash=? WHERE id=?",
                    (previous_hash, entry_hash, int(row["id"])),
                )
                previous_hash = entry_hash

        # Seeding in autocommit mode forces one durable write for every row.
        # Keep the whole synthetic import atomic so API startup stays quick.
        connection.execute("BEGIN IMMEDIATE")
        account_ids = sorted(
            {
                str(transaction.get("source_account", "")).strip().upper()
                for transaction in transactions
            }
            | {
                str(transaction.get("target_account", "")).strip().upper()
                for transaction in transactions
            }
        )
        now = _iso()
        for account_id in account_ids:
            if not account_id:
                continue
            balance_seed = int.from_bytes(hashlib.sha256(account_id.encode("utf-8")).digest()[:4], "big")
            opening_balance = 30000 + (balance_seed % 170000)
            connection.execute(
                "INSERT OR IGNORE INTO accounts(account_id,currency,opening_balance,created_at) VALUES(?,?,?,?)",
                (account_id, "INR", opening_balance, now),
            )

        for transaction in transactions:
            tx_id = str(transaction.get("transaction_id", "")).strip()
            source = str(transaction.get("source_account", "")).strip().upper()
            target = str(transaction.get("target_account", "")).strip().upper()
            if not tx_id or not source or not target:
                continue
            status_seed = hashlib.sha256(tx_id.encode("utf-8")).digest()[0] % 100
            status = "COMPLETED" if status_seed < 88 else "PENDING" if status_seed < 96 else "REVERSED"
            try:
                amount = round(float(transaction.get("amount", 0)), 2)
            except (TypeError, ValueError):
                continue
            connection.execute(
                """INSERT OR IGNORE INTO transactions(
                       transaction_id,source_account,target_account,amount,amount_inr,currency,
                       timestamp,status,merchant_id,location,source_provider
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    tx_id,
                    source,
                    target,
                    amount,
                    transaction.get("amount_inr", amount if str(transaction.get("currency") or "INR").upper() == "INR" else None),
                    str(transaction.get("currency") or "INR").upper(),
                    str(transaction.get("timestamp") or now),
                    status,
                    transaction.get("merchant_id"),
                    transaction.get("location"),
                    transaction.get("source_provider"),
                ),
            )
        connection.commit()
    _AUDIT_CHAIN_VALID = verify_audit_chain()
    return _AUDIT_CHAIN_VALID


def _new_session(connection: sqlite3.Connection, user_id: int) -> str:
    raw_token = secrets.token_urlsafe(32)
    created = _now()
    connection.execute(
        "INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
        (_token_digest(raw_token), user_id, _iso(created), _iso(created + timedelta(seconds=SESSION_TTL_SECONDS))),
    )
    return raw_token


def signup_customer(email: str, display_name: str, password: str) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    email = email.strip().lower()
    display_name = display_name.strip()
    salt, password_hash = _password_record(password)
    with _connect() as connection:
        try:
            connection.execute("BEGIN IMMEDIATE")
            available = connection.execute(
                """SELECT account_id FROM accounts
                   WHERE account_id NOT IN (SELECT account_id FROM linked_accounts)
                   ORDER BY account_id LIMIT 2"""
            ).fetchall()
            cursor = connection.execute(
                "INSERT INTO users(email,display_name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                (email, display_name, salt, password_hash, "customer", _iso()),
            )
            user_id = int(cursor.lastrowid)
            if len(available) >= 2:
                for row in available:
                    connection.execute(
                        "INSERT INTO linked_accounts(user_id,account_id,linked_at) VALUES(?,?,?)",
                        (user_id, row["account_id"], _iso()),
                    )
            else:
                _create_synthetic_customer_accounts(connection, user_id)
            token = _new_session(connection, user_id)
            accounts = _accounts_for_user(connection, user_id)
            connection.commit()
        except sqlite3.IntegrityError as error:
            connection.rollback()
            if "users.email" in str(error).lower() or "unique constraint failed: users.email" in str(error).lower():
                raise ValueError("An account with this email already exists. Try logging in instead.") from error
            raise
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
    return {"id": user_id, "email": email, "name": display_name, "role": "customer"}, token, accounts


def _allow_login_attempt(connection: sqlite3.Connection, source: str) -> None:
    source_hash = hashlib.sha256((source or "unknown").encode("utf-8")).hexdigest()
    now = _now()
    row = connection.execute("SELECT window_started_at,attempt_count FROM login_attempts WHERE source_hash=?", (source_hash,)).fetchone()
    if row:
        try:
            window_start = datetime.fromisoformat(str(row["window_started_at"]).replace("Z", "+00:00"))
        except ValueError:
            window_start = now - timedelta(seconds=LOGIN_WINDOW_SECONDS + 1)
        if (now - window_start).total_seconds() < LOGIN_WINDOW_SECONDS:
            count = int(row["attempt_count"])
            if count >= LOGIN_MAX_ATTEMPTS:
                raise PortalRateLimitError("Too many login attempts. Wait 15 minutes and try again.")
            connection.execute("UPDATE login_attempts SET attempt_count=attempt_count+1 WHERE source_hash=?", (source_hash,))
            return
    connection.execute(
        "INSERT INTO login_attempts(source_hash,window_started_at,attempt_count) VALUES(?,?,1) ON CONFLICT(source_hash) DO UPDATE SET window_started_at=excluded.window_started_at,attempt_count=1",
        (source_hash, _iso(now)),
    )


def login_customer(email: str, password: str, source: str) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _allow_login_attempt(connection, source)
        row = connection.execute("SELECT id,email,display_name,password_salt,password_hash,role FROM users WHERE email=? COLLATE NOCASE", (email.strip().lower(),)).fetchone()
        valid = False
        if row and row["role"] == "customer":
            try:
                _, candidate = _password_record(password, bytes.fromhex(row["password_salt"]))
                valid = hmac.compare_digest(candidate, str(row["password_hash"]))
            except (ValueError, TypeError):
                valid = False
        if not valid:
            connection.commit()
            return {}, "", []
        source_hash = hashlib.sha256((source or "unknown").encode("utf-8")).hexdigest()
        connection.execute("DELETE FROM login_attempts WHERE source_hash=?", (source_hash,))
        connection.execute("DELETE FROM sessions WHERE expires_at<=?", (_iso(),))
        token = _new_session(connection, int(row["id"]))
        accounts = _accounts_for_user(connection, int(row["id"]))
        connection.commit()
        return {"id": int(row["id"]), "email": row["email"], "name": row["display_name"], "role": row["role"]}, token, accounts


def customer_for_session(raw_token: str | None) -> dict[str, Any] | None:
    if not raw_token:
        return None
    with _connect() as connection:
        row = connection.execute(
            """SELECT u.id,u.email,u.display_name,u.role,s.expires_at
               FROM sessions s JOIN users u ON u.id=s.user_id
               WHERE s.token_hash=?""",
            (_token_digest(raw_token),),
        ).fetchone()
        if not row or row["role"] != "customer" or str(row["expires_at"]) <= _iso():
            return None
        return {"id": int(row["id"]), "email": row["email"], "name": row["display_name"], "role": row["role"]}


def logout_customer(raw_token: str | None) -> None:
    if not raw_token:
        return
    with _connect() as connection:
        connection.execute("DELETE FROM sessions WHERE token_hash=?", (_token_digest(raw_token),))


def _accounts_for_user(connection: sqlite3.Connection, user_id: int) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT a.account_id,a.currency,a.opening_balance,la.linked_at,
                  COALESCE((SELECT SUM(CASE WHEN t.currency=a.currency THEN t.amount ELSE t.amount_inr END)
                            FROM transactions t WHERE t.target_account=a.account_id),0) AS inbound,
                  COALESCE((SELECT SUM(CASE WHEN t.currency=a.currency THEN t.amount ELSE t.amount_inr END)
                            FROM transactions t WHERE t.source_account=a.account_id),0) AS outbound,
                  (SELECT COUNT(*) FROM transactions t WHERE t.target_account=a.account_id OR t.source_account=a.account_id) AS transaction_count
           FROM linked_accounts la JOIN accounts a ON a.account_id=la.account_id
           WHERE la.user_id=? ORDER BY a.account_id""",
        (user_id,),
    ).fetchall()
    return [
        {
            "account_id": row["account_id"],
            "name": f"Sample account {str(row['account_id'])[-3:]}",
            "currency": row["currency"],
            "balance": round(max(0.0, float(row["opening_balance"]) + float(row["inbound"]) - float(row["outbound"])), 2),
            "balance_label": "Synthetic balance",
            "transaction_count": int(row["transaction_count"]),
            "linked_at": row["linked_at"],
            "is_synthetic": True,
        }
        for row in rows
    ]


def _create_synthetic_customer_accounts(connection: sqlite3.Connection, user_id: int) -> None:
    """Extend the finite bundled samples with private, non-shared demo accounts.

    Values and metadata are sampled from the bundled transaction rows, while
    account and transaction identifiers are unique to this customer.
    """
    templates = connection.execute(
        "SELECT amount,currency,timestamp,status,merchant_id,location FROM transactions ORDER BY transaction_id LIMIT 12"
    ).fetchall()
    if not templates:
        raise ValueError("Synthetic transaction samples are not installed on this server.")

    now = _iso()
    account_ids = [f"SAMPLE_{user_id:08d}_A", f"SAMPLE_{user_id:08d}_B"]
    for account_id in account_ids:
        balance_seed = int.from_bytes(hashlib.sha256(account_id.encode("utf-8")).digest()[:4], "big")
        opening_balance = 30000 + (balance_seed % 170000)
        connection.execute(
            "INSERT INTO accounts(account_id,currency,opening_balance,created_at) VALUES(?,?,?,?)",
            (account_id, "INR", opening_balance, now),
        )
        connection.execute(
            "INSERT INTO linked_accounts(user_id,account_id,linked_at) VALUES(?,?,?)",
            (user_id, account_id, now),
        )

    for index, row in enumerate(templates, start=1):
        source, target = (account_ids[0], account_ids[1]) if index % 2 else (account_ids[1], account_ids[0])
        connection.execute(
            """INSERT INTO transactions(
                   transaction_id,source_account,target_account,amount,amount_inr,currency,
                   timestamp,status,merchant_id,location,source_provider
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                f"SAMPLE_TX_{user_id:08d}_{index:03d}",
                source,
                target,
                float(row["amount"]),
                float(row["amount"]),
                "INR",
                row["timestamp"],
                row["status"],
                row["merchant_id"],
                row["location"],
                "synthetic-preview-template",
            ),
        )


def customer_accounts(user_id: int) -> list[dict[str, Any]]:
    with _connect() as connection:
        return _accounts_for_user(connection, user_id)


def update_customer_name(user_id: int, display_name: str) -> dict[str, Any]:
    with _connect() as connection:
        connection.execute("UPDATE users SET display_name=? WHERE id=? AND role='customer'", (display_name.strip(), user_id))
        row = connection.execute("SELECT id,email,display_name,role FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            raise ValueError("Customer account not found.")
        return {"id": int(row["id"]), "email": row["email"], "name": row["display_name"], "role": row["role"]}


def change_customer_password(user_id: int, current_password: str, new_password: str, current_session: str | None) -> None:
    with _connect() as connection:
        row = connection.execute("SELECT password_salt,password_hash FROM users WHERE id=? AND role='customer'", (user_id,)).fetchone()
        if not row:
            raise ValueError("Customer account not found.")
        _, candidate = _password_record(current_password, bytes.fromhex(row["password_salt"]))
        if not hmac.compare_digest(candidate, str(row["password_hash"])):
            raise PermissionError("Your current password is incorrect.")
        salt, password_hash = _password_record(new_password)
        connection.execute("UPDATE users SET password_salt=?,password_hash=? WHERE id=?", (salt, password_hash, user_id))
        if current_session:
            connection.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, _token_digest(current_session)))
        else:
            connection.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def linked_account_ids(connection: sqlite3.Connection, user_id: int) -> list[str]:
    return [str(row["account_id"]) for row in connection.execute("SELECT account_id FROM linked_accounts WHERE user_id=? ORDER BY account_id", (user_id,)).fetchall()]


def _transaction_query(connection: sqlite3.Connection, user_id: int, filters: dict[str, Any], *, limit: int | None = None, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
    accounts = linked_account_ids(connection, user_id)
    if not accounts:
        return [], 0
    marks = ",".join("?" for _ in accounts)
    clauses = [f"(source_account IN ({marks}) OR target_account IN ({marks}))"]
    parameters: list[Any] = [*accounts, *accounts]
    query = str(filters.get("q", "")).strip()
    if query:
        clauses.append("(transaction_id LIKE ? OR source_account LIKE ? OR target_account LIKE ? OR COALESCE(merchant_id,'') LIKE ? OR COALESCE(location,'') LIKE ?)")
        like = f"%{query}%"
        parameters.extend([like] * 5)
    start = filters.get("from")
    if start:
        clauses.append("timestamp >= ?")
        parameters.append(start)
    end = filters.get("to_exclusive")
    if end:
        clauses.append("timestamp < ?")
        parameters.append(end)
    minimum = filters.get("min_amount")
    if minimum is not None:
        clauses.append("amount >= ?")
        parameters.append(minimum)
    maximum = filters.get("max_amount")
    if maximum is not None:
        clauses.append("amount <= ?")
        parameters.append(maximum)
    direction = str(filters.get("direction", "all")).lower()
    if direction == "outgoing":
        clauses.append(f"source_account IN ({marks})")
        parameters.extend(accounts)
    elif direction == "incoming":
        clauses.append(f"target_account IN ({marks})")
        parameters.extend(accounts)
    status = str(filters.get("status", "all")).upper()
    if status in {"COMPLETED", "PENDING", "REVERSED"}:
        clauses.append("status=?")
        parameters.append(status)
    order_by = {
        "date_asc": "timestamp ASC, transaction_id ASC",
        "date_desc": "timestamp DESC, transaction_id DESC",
        "amount_asc": "amount ASC, timestamp DESC",
        "amount_desc": "amount DESC, timestamp DESC",
    }.get(str(filters.get("sort", "date_desc")), "timestamp DESC, transaction_id DESC")
    where = " AND ".join(clauses)
    total = int(connection.execute(f"SELECT COUNT(*) FROM transactions WHERE {where}", parameters).fetchone()[0])
    sql = f"SELECT transaction_id,source_account,target_account,amount,amount_inr,currency,timestamp,status,merchant_id,location,source_provider FROM transactions WHERE {where} ORDER BY {order_by}"
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        parameters.extend([limit, offset])
    rows = connection.execute(sql, parameters).fetchall()
    own = set(accounts)
    return [
        {
            "transaction_id": row["transaction_id"],
            "source_account": row["source_account"] if row["source_account"] in own else "External account",
            "target_account": row["target_account"] if row["target_account"] in own else "External account",
            "amount": float(row["amount"]),
            "amount_inr": row["amount_inr"],
            "currency": row["currency"],
            "timestamp": row["timestamp"],
            "status": row["status"],
            "merchant": row["merchant_id"],
            "location": row["location"],
            "source_provider": row["source_provider"],
            "direction": "outgoing" if row["source_account"] in own else "incoming",
            "account_id": row["source_account"] if row["source_account"] in own else row["target_account"],
            "is_synthetic": True,
        }
        for row in rows
    ], total


def list_customer_transactions(user_id: int, filters: dict[str, Any], *, limit: int | None = None, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
    with _connect() as connection:
        return _transaction_query(connection, user_id, filters, limit=limit, offset=offset)


def get_customer_transaction(user_id: int, transaction_id: str) -> dict[str, Any] | None:
    with _connect() as connection:
        rows, _ = _transaction_query(connection, user_id, {"q": transaction_id, "sort": "date_desc"})
        return next((row for row in rows if row["transaction_id"] == transaction_id), None)


def _amount_in_account_currency(transaction: dict[str, Any], currency: str) -> float | None:
    """Return a comparable value without adding unlike currencies together."""
    converted = transaction.get("amount_inr")
    if converted is not None:
        try:
            return float(converted)
        except (TypeError, ValueError):
            return None
    if str(transaction.get("currency") or "").upper() == currency.upper():
        try:
            return float(transaction.get("amount") or 0)
        except (TypeError, ValueError):
            return None
    return None


def customer_intelligence(user_id: int) -> dict[str, Any]:
    """Build a customer's private graph and transparent, account-level signals.

    The only records considered are transactions touching one of the user's
    linked accounts. Counterparties outside that scope are collapsed into one
    generic graph node and never returned by identifier.
    """
    with _connect() as connection:
        accounts = _accounts_for_user(connection, user_id)
        account_ids = {str(account["account_id"]) for account in accounts}
        transactions, _ = _transaction_query(connection, user_id, {"sort": "date_desc"})

    nodes = [
        {"id": account["account_id"], "label": account["name"], "kind": "account"}
        for account in accounts
    ]
    edge_groups: dict[tuple[str, str], dict[str, Any]] = {}
    per_account: dict[str, list[dict[str, Any]]] = {account_id: [] for account_id in account_ids}
    has_external = False

    for transaction in transactions:
        source = str(transaction["source_account"])
        target = str(transaction["target_account"])
        if source == "External account" or target == "External account":
            has_external = True
        graph_source = source if source in account_ids else "outside"
        graph_target = target if target in account_ids else "outside"
        if graph_source != graph_target:
            key = (graph_source, graph_target)
            edge = edge_groups.setdefault(key, {"source": graph_source, "target": graph_target, "transaction_count": 0, "amount_inr": 0.0, "evidence_transaction_ids": []})
            edge["transaction_count"] += 1
            comparable = _amount_in_account_currency(transaction, "INR")
            if comparable is not None:
                edge["amount_inr"] += comparable
            edge["evidence_transaction_ids"].append(transaction["transaction_id"])

        for account_id in account_ids:
            if source == account_id or target == account_id:
                per_account[account_id].append(transaction)

    if has_external:
        nodes.append({"id": "outside", "label": "Outside linked accounts", "kind": "external"})

    account_summaries: list[dict[str, Any]] = []
    for account in accounts:
        account_id = str(account["account_id"])
        rows = per_account[account_id]
        outgoing = [item for item in rows if item["source_account"] == account_id]
        incoming = [item for item in rows if item["target_account"] == account_id]
        pending = [item for item in rows if str(item["status"]).upper() == "PENDING"]
        reversed_rows = [item for item in rows if str(item["status"]).upper() == "REVERSED"]
        own_to_own = [
            item for item in rows
            if item["source_account"] in account_ids and item["target_account"] in account_ids
        ]

        comparable_rows = [
            (item, _amount_in_account_currency(item, str(account["currency"])))
            for item in rows
        ]
        comparable_rows = [(item, amount) for item, amount in comparable_rows if amount is not None]
        comparable_values = sorted(amount for _item, amount in comparable_rows)
        median_amount = comparable_values[len(comparable_values) // 2] if comparable_values else None
        if len(comparable_values) % 2 == 0 and comparable_values:
            median_amount = (comparable_values[len(comparable_values) // 2 - 1] + comparable_values[len(comparable_values) // 2]) / 2
        large_rows = [
            item for item, amount in comparable_rows
            if len(comparable_values) >= 5 and median_amount and amount >= median_amount * 3
        ]

        timed_rows: list[tuple[datetime, dict[str, Any]]] = []
        for item in rows:
            try:
                stamp = datetime.fromisoformat(str(item["timestamp"]).replace("Z", "+00:00"))
                if stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=timezone.utc)
                timed_rows.append((stamp, item))
            except (TypeError, ValueError):
                continue
        timed_rows.sort(key=lambda pair: pair[0])
        burst_rows: list[dict[str, Any]] = []
        start = 0
        for end, (stamp, _item) in enumerate(timed_rows):
            while start <= end and (stamp - timed_rows[start][0]).total_seconds() > 600:
                start += 1
            if end - start + 1 >= 5:
                burst_rows = [pair[1] for pair in timed_rows[start:end + 1]]
                break

        statuses_with_evidence = pending + reversed_rows
        signals = [
            {
                "key": "unusual_amount",
                "title": "Amount well above this account's median",
                "matched": bool(large_rows),
                "explanation": (
                    f"{len(large_rows)} transaction(s) are at least three times the median of {len(comparable_values)} comparable transactions ({median_amount:,.2f} {account['currency']})."
                    if large_rows and median_amount is not None
                    else f"No transaction reached three times the median across {len(comparable_values)} comparable transactions. At least five comparable records are needed for this check."
                ),
                "evidence_transaction_ids": [item["transaction_id"] for item in large_rows[:5]],
            },
            {
                "key": "rapid_activity",
                "title": "Rapid activity",
                "matched": bool(burst_rows),
                "explanation": (
                    f"{len(burst_rows)} transactions fall inside a 10-minute window."
                    if burst_rows else "No window with five or more transactions inside 10 minutes was found."
                ),
                "evidence_transaction_ids": [item["transaction_id"] for item in burst_rows[:5]],
            },
            {
                "key": "status_attention",
                "title": "Pending or reversed status",
                "matched": bool(statuses_with_evidence),
                "explanation": f"{len(pending)} pending and {len(reversed_rows)} reversed transaction(s) appear in this account's history.",
                "evidence_transaction_ids": [item["transaction_id"] for item in statuses_with_evidence[:5]],
            },
            {
                "key": "linked_movement",
                "title": "Movement between your linked accounts",
                "matched": bool(own_to_own),
                "explanation": f"{len(own_to_own)} transaction(s) connect accounts linked to your own workspace.",
                "evidence_transaction_ids": [item["transaction_id"] for item in own_to_own[:5]],
            },
        ]
        inbound_total = sum(
            amount for item, amount in comparable_rows if item["target_account"] == account_id
        )
        outbound_total = sum(
            amount for item, amount in comparable_rows if item["source_account"] == account_id
        )
        account_summaries.append({
            "account_id": account_id,
            "name": account["name"],
            "currency": account["currency"],
            "transaction_count": len(rows),
            "incoming_count": len(incoming),
            "outgoing_count": len(outgoing),
            "pending_count": len(pending),
            "reversed_count": len(reversed_rows),
            "incoming_total": round(inbound_total, 2),
            "outgoing_total": round(outbound_total, 2),
            "signals": signals,
        })

    return {
        "graph": {
            "nodes": nodes,
            "edges": [
                {**edge, "amount_inr": round(float(edge["amount_inr"]), 2)}
                for edge in edge_groups.values()
            ],
        },
        "accounts": account_summaries,
        "disclaimer": "Transparent review rules over synthetic data. These indicators are not a fraud probability or an automated decision.",
    }


def record_audit(user_id: int, action: str, resource_type: str, resource_id: str | None = None) -> None:
    if _AUDIT_CHAIN_VALID is False:
        raise RuntimeError("The customer audit trail failed its integrity check; audit writes are paused.")
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        previous = connection.execute("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
        previous_hash = str(previous["entry_hash"]) if previous else _AUDIT_ZERO_HASH
        occurred_at = _iso()
        cursor = connection.execute(
            "INSERT INTO audit_log(user_id,action,resource_type,resource_id,occurred_at,previous_hash,entry_hash) VALUES(?,?,?,?,?,?,?)",
            (user_id, action, resource_type, resource_id, occurred_at, previous_hash, ""),
        )
        entry = {
            "id": int(cursor.lastrowid),
            "user_id": int(user_id),
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "occurred_at": occurred_at,
        }
        connection.execute(
            "UPDATE audit_log SET entry_hash=? WHERE id=?",
            (_audit_entry_hash(entry, previous_hash), int(cursor.lastrowid)),
        )
        connection.commit()


def verify_audit_chain() -> bool:
    """Return whether all stored audit entries form an intact SHA-256 chain."""
    global _AUDIT_CHAIN_VALID
    previous_hash = _AUDIT_ZERO_HASH
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id,user_id,action,resource_type,resource_id,occurred_at,previous_hash,entry_hash FROM audit_log ORDER BY id"
        ).fetchall()
    for row in rows:
        if not hmac.compare_digest(str(row["previous_hash"]), previous_hash):
            _AUDIT_CHAIN_VALID = False
            return False
        expected_hash = _audit_entry_hash(row, previous_hash)
        if not hmac.compare_digest(str(row["entry_hash"]), expected_hash):
            _AUDIT_CHAIN_VALID = False
            return False
        previous_hash = expected_hash
    _AUDIT_CHAIN_VALID = True
    return True


def reported_case(user_id: int, transaction_id: str) -> dict[str, Any] | None:
    with _connect() as connection:
        row = connection.execute("SELECT case_id,account_id,transaction_id,created_at FROM cases WHERE user_id=? AND transaction_id=?", (user_id, transaction_id)).fetchone()
        return dict(row) if row else None


def reported_cases(user_id: int) -> list[dict[str, Any]]:
    """List only cases this customer reported for their linked accounts."""
    with _connect() as connection:
        rows = connection.execute(
            """SELECT c.case_id,c.account_id,c.transaction_id,c.status,c.priority,c.created_at,
                      t.timestamp AS transaction_timestamp,t.status AS transaction_status,
                      t.amount,t.currency,t.merchant_id
               FROM cases c
               JOIN linked_accounts la ON la.user_id=c.user_id AND la.account_id=c.account_id
               JOIN transactions t ON t.transaction_id=c.transaction_id
               WHERE c.user_id=? AND (t.source_account=c.account_id OR t.target_account=c.account_id)
               ORDER BY c.created_at DESC,c.case_id DESC""",
            (user_id,),
        ).fetchall()
        return [dict(row) for row in rows]


def record_reported_case(user_id: int, case_id: str, account_id: str, transaction_id: str) -> None:
    with _connect() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO cases(case_id,user_id,account_id,transaction_id,status,priority,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (case_id, user_id, account_id, transaction_id, "OPEN", "HIGH", "Customer transaction report", _iso()),
        )
