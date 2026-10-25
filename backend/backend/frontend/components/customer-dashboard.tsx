"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CircleArrowOutUpRight, Clock3, CreditCard, Landmark } from "lucide-react";
import { PortalAccount, PortalShell, usePortal } from "@/components/portal-shell";

type Transaction = { transaction_id: string; account_id: string; source_account: string; target_account: string; amount: number; currency: string; timestamp: string; status: string; direction: "incoming" | "outgoing"; merchant?: string; location?: string };

const currency = (amount: number, code = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(amount);
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

function AccountCard({ account }: { account: PortalAccount }) {
  return <article className="account-card"><div className="account-card-top"><span className="account-icon"><Landmark size={19}/></span><span className="account-kind">Sample account</span></div><p className="account-name">{account.name}</p><p className="account-id">{account.account_id}</p><strong className="account-balance">{currency(account.balance, account.currency)}</strong><div className="account-card-bottom"><span>{account.balance_label}</span><span>{account.transaction_count} transactions</span></div></article>;
}

function OverviewContent() {
  const { user, accounts } = usePortal();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/portal/transactions?page=1&page_size=6&sort=date_desc", { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.detail || "Recent activity is unavailable."); return payload; })
      .then((payload) => setTransactions(Array.isArray(payload.transactions) ? payload.transactions : []))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Recent activity is unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  return <>
    <div className="portal-welcome-row"><div><p className="welcome-label">Good to see you</p><h2>{user.name}</h2><p>Your sample accounts and recent activity are ready to review.</p></div><Link className="button button-primary" href="/dashboard/transactions">View transactions <ArrowRight size={16}/></Link></div>
    <section className="portal-overview-cards" aria-label="Workspace summary"><article className="summary-card summary-card-primary"><span className="summary-icon"><CreditCard size={19}/></span><span className="summary-label">Total sample balance</span><strong>{currency(totalBalance)}</strong><small>Across {accounts.length} linked sample accounts</small></article><article className="summary-card"><span className="summary-icon"><Landmark size={19}/></span><span className="summary-label">Linked accounts</span><strong>{accounts.length}</strong><small>Accounts visible to this login</small></article><article className="summary-card"><span className="summary-icon"><Clock3 size={19}/></span><span className="summary-label">Recent activity</span><strong>{transactions.length}</strong><small>Latest items shown below</small></article></section>
    <section className="portal-section"><div className="portal-section-heading"><div><h2>Your linked accounts</h2><p>These balances are generated for the synthetic preview.</p></div><Link className="portal-inline-link" href="/dashboard/settings">Manage settings <ArrowRight size={15}/></Link></div><div className="account-card-grid">{accounts.length ? accounts.map((account) => <AccountCard key={account.account_id} account={account}/>) : <div className="portal-empty">No accounts are linked to this workspace.</div>}</div></section>
    <section className="portal-section"><div className="portal-section-heading"><div><h2>Recent transactions</h2><p>Latest activity across your linked accounts.</p></div><Link className="portal-inline-link" href="/dashboard/transactions">See all transactions <ArrowRight size={15}/></Link></div>
      {loading ? <div className="portal-table-state">Loading recent activity…</div> : error ? <div className="portal-table-state portal-state-error">{error}</div> : transactions.length ? <div className="transaction-table-wrap"><table className="transaction-table"><thead><tr><th>Transaction</th><th>Account</th><th>Date</th><th>Status</th><th className="amount-cell">Amount</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.transaction_id}><td><span className={`direction-icon ${transaction.direction}`} >{transaction.direction === "incoming" ? <ArrowDownLeft size={16}/> : <ArrowUpRight size={16}/>}</span><span className="transaction-primary"><strong>{transaction.merchant || (transaction.direction === "incoming" ? "Incoming transfer" : "Outgoing transfer")}</strong><small>{transaction.transaction_id}</small></span></td><td>{transaction.account_id}</td><td>{dateLabel(transaction.timestamp)}</td><td><span className={`status-pill status-${transaction.status.toLowerCase()}`}>{transaction.status.toLowerCase()}</span></td><td className="amount-cell"><strong className={transaction.direction === "incoming" ? "amount-in" : ""}>{transaction.direction === "incoming" ? "+" : "−"}{currency(transaction.amount, transaction.currency)}</strong></td><td><Link href={`/dashboard/transactions/${encodeURIComponent(transaction.transaction_id)}`} className="table-open-link" aria-label={`Open transaction ${transaction.transaction_id}`}><CircleArrowOutUpRight size={16}/></Link></td></tr>)}</tbody></table></div> : <div className="portal-empty">No sample transactions found yet.</div>}
    </section>
    <p className="portal-demo-note">This is a synthetic-data preview. Sample balances and transaction statuses do not represent real money or bank activity.</p>
  </>;
}

export function CustomerDashboard() {
  return <PortalShell active="overview" title="Overview" subtitle="A simple view of your linked sample accounts and recent activity."><OverviewContent /></PortalShell>;
}
