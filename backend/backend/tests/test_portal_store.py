"""Regression checks for customer data boundaries and account balances."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import portal_store


class PortalStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_db_path = portal_store._DB_PATH
        self._temporary_directory = tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parent
        )
        database_path = Path(self._temporary_directory.name) / "portal.sqlite3"
        transactions = [
            {
                "transaction_id": "TX-USD-OUT",
                "source_account": "ACC_A",
                "target_account": "ACC_C",
                "amount": 10.0,
                "amount_inr": 830.0,
                "currency": "USD",
                "timestamp": "2026-10-20T10:00:00Z",
            },
            {
                "transaction_id": "TX-USD-IN",
                "source_account": "ACC_D",
                "target_account": "ACC_A",
                "amount": 5.0,
                "amount_inr": 415.0,
                "currency": "USD",
                "timestamp": "2026-10-20T11:00:00Z",
            },
            {
                "transaction_id": "TX-INR-OWN",
                "source_account": "ACC_B",
                "target_account": "ACC_A",
                "amount": 7.0,
                "amount_inr": 7.0,
                "currency": "INR",
                "timestamp": "2026-10-20T12:00:00Z",
            },
            {
                "transaction_id": "TX-OTHER-CUSTOMER",
                "source_account": "ACC_C",
                "target_account": "ACC_D",
                "amount": 99.0,
                "amount_inr": 99.0,
                "currency": "INR",
                "timestamp": "2026-10-20T13:00:00Z",
            },
        ]
        portal_store.initialize_portal_store(database_path, transactions)
        self.user_one, self.token_one, _ = portal_store.signup_customer(
            "one@example.test", "Customer One", "secure-test-password-one"
        )
        self.user_two, self.token_two, _ = portal_store.signup_customer(
            "two@example.test", "Customer Two", "secure-test-password-two"
        )

    def tearDown(self) -> None:
        portal_store._DB_PATH = self._old_db_path
        self._temporary_directory.cleanup()

    def test_balances_convert_foreign_transactions_to_account_currency(self) -> None:
        accounts = {
            account["account_id"]: account
            for account in portal_store.customer_accounts(self.user_one["id"])
        }
        account_a = accounts["ACC_A"]
        expected = round(self._opening_balance("ACC_A") + 415.0 + 7.0 - 830.0, 2)
        self.assertEqual(account_a["currency"], "INR")
        self.assertEqual(account_a["balance"], expected)

    def test_customer_cannot_read_another_customers_only_transaction(self) -> None:
        transactions, _ = portal_store.list_customer_transactions(
            self.user_one["id"], {}, limit=50
        )
        transaction_ids = {transaction["transaction_id"] for transaction in transactions}
        self.assertIn("TX-USD-OUT", transaction_ids)
        self.assertNotIn("TX-OTHER-CUSTOMER", transaction_ids)
        self.assertIsNone(
            portal_store.get_customer_transaction(
                self.user_one["id"], "TX-OTHER-CUSTOMER"
            )
        )

    def test_counterparty_account_ids_are_hidden_and_logout_revokes_session(self) -> None:
        transaction = portal_store.get_customer_transaction(
            self.user_one["id"], "TX-USD-OUT"
        )
        self.assertIsNotNone(transaction)
        assert transaction is not None
        self.assertEqual(transaction["target_account"], "External account")
        self.assertEqual(
            portal_store.customer_for_session(self.token_one)["id"],
            self.user_one["id"],
        )
        portal_store.logout_customer(self.token_one)
        self.assertIsNone(portal_store.customer_for_session(self.token_one))

    def test_customer_intelligence_graph_and_signals_stay_inside_linked_accounts(self) -> None:
        intelligence = portal_store.customer_intelligence(self.user_one["id"])
        node_ids = {node["id"] for node in intelligence["graph"]["nodes"]}
        self.assertEqual(node_ids, {"ACC_A", "ACC_B", "outside"})
        self.assertTrue(all(node["id"] not in {"ACC_C", "ACC_D"} for node in intelligence["graph"]["nodes"]))
        graph_text = repr(intelligence["graph"])
        self.assertNotIn("ACC_C", graph_text)
        self.assertNotIn("ACC_D", graph_text)
        account_ids = {account["account_id"] for account in intelligence["accounts"]}
        self.assertEqual(account_ids, {"ACC_A", "ACC_B"})
        self.assertTrue(all(len(account["signals"]) == 4 for account in intelligence["accounts"]))
        self.assertEqual(
            intelligence["disclaimer"],
            "Transparent review rules over synthetic data. These indicators are not a fraud probability or an automated decision.",
        )

    def test_customer_case_list_contains_only_their_own_reported_transactions(self) -> None:
        portal_store.record_reported_case(self.user_one["id"], "CASE-OWN", "ACC_A", "TX-USD-OUT")
        portal_store.record_reported_case(self.user_two["id"], "CASE-OTHER", "ACC_C", "TX-OTHER-CUSTOMER")
        cases = portal_store.reported_cases(self.user_one["id"])
        self.assertEqual([item["case_id"] for item in cases], ["CASE-OWN"])
        self.assertEqual(cases[0]["transaction_id"], "TX-USD-OUT")
        self.assertEqual(cases[0]["account_id"], "ACC_A")

    def test_login_uses_case_insensitive_email_and_password_hash(self) -> None:
        user, token, _ = portal_store.login_customer(
            "ONE@EXAMPLE.TEST", "secure-test-password-one", "test-client"
        )
        self.assertEqual(user["id"], self.user_one["id"])
        self.assertTrue(token)
        rejected, rejected_token, _ = portal_store.login_customer(
            "one@example.test", "incorrect-password", "test-client"
        )
        self.assertEqual(rejected, {})
        self.assertEqual(rejected_token, "")

    def _opening_balance(self, account_id: str) -> float:
        with portal_store._connect() as connection:
            row = connection.execute(
                "SELECT opening_balance FROM accounts WHERE account_id=?",
                (account_id,),
            ).fetchone()
        assert row is not None
        return float(row["opening_balance"])


if __name__ == "__main__":
    unittest.main()
