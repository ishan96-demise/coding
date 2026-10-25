"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Download, Search } from "lucide-react";
import { PortalShell } from "@/components/portal-shell";

type Transaction = { transaction_id: string; account_id: string; source_account: string; target_account: string; amount: number; currency: string; timestamp: string; status: string; direction: "incoming" | "outgoing"; merchant?: string; location?: string };
type Filters = { q: string; from: string; to: string; min_amount: string; max_amount: string; direction: string; status: string; sort: string };
const initialFilters: Filters = { q: "", from: "", to: "", min_amount: "", max_amount: "", direction: "all", status: "all", sort: "date_desc" };
const formatCurrency = (amount: number, currency = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
const formatDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

function queryFor(filters: Filters, page = 1) {
  const query = new URLSearchParams({ page: String(page), page_size: "20", sort: filters.sort });
  for (const key of ["q", "from", "to", "min_amount", "max_amount", "direction", "status"] as const) if (filters[key]) query.set(key, filters[key]);
  return query.toString();
}

function TransactionsContent() {
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      fetch(`/api/portal/transactions?${queryFor(filters, page)}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.detail || "Transaction history could not be loaded."); return payload; })
        .then((payload) => { setTransactions(Array.isArray(payload.transactions) ? payload.transactions : []); setTotal(Number(payload.total) || 0); setPages(Math.max(1, Number(payload.pages) || 1)); })
        .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Transaction history could not be loaded."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 130);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filters, page]);

  const range = useMemo(() => total ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, total)} of ${total}` : "0 results", [page, total]);
  const updateDraft = (key: keyof Filters, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const applyFilters = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); setPage(1); setFilters({ ...draft }); };
  const resetFilters = () => { setDraft(initialFilters); setFilters(initialFilters); setPage(1); };
  const exportCsv = async () => {
    setExporting(true);
    setError("");
    try {
      const response = await fetch(`/api/portal/transactions/export.csv?${queryFor(filters)}`, { cache: "no-store" });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.detail || "CSV export could not be created."); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "fin-sentinels-transactions.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "CSV export could not be created.");
    } finally { setExporting(false); }
  };

  return <>
    <section className="filter-panel"><div className="filter-panel-heading"><div><h2>Find a transaction</h2><p>Filter the records linked to your sample accounts.</p></div><button type="button" className="button button-outline export-button" onClick={exportCsv} disabled={exporting || total === 0}><Download size={16}/>{exporting ? "Preparing CSV…" : "Export CSV"}</button></div>
      <form className="transaction-filters" onSubmit={applyFilters}>
        <label className="filter-control filter-search"><span>Search</span><span className="search-field"><Search size={17}/><input value={draft.q} onChange={(event) => updateDraft("q", event.target.value)} placeholder="ID, account, merchant, or location" /></span></label>
        <label className="filter-control"><span>From date</span><input type="date" value={draft.from} onChange={(event) => updateDraft("from", event.target.value)} /></label>
        <label className="filter-control"><span>To date</span><input type="date" value={draft.to} onChange={(event) => updateDraft("to", event.target.value)} /></label>
        <label className="filter-control"><span>Minimum amount</span><input inputMode="decimal" type="number" min="0" step="0.01" value={draft.min_amount} onChange={(event) => updateDraft("min_amount", event.target.value)} placeholder="₹0" /></label>
        <label className="filter-control"><span>Maximum amount</span><input inputMode="decimal" type="number" min="0" step="0.01" value={draft.max_amount} onChange={(event) => updateDraft("max_amount", event.target.value)} placeholder="No limit" /></label>
        <label className="filter-control"><span>Direction</span><select value={draft.direction} onChange={(event) => updateDraft("direction", event.target.value)}><option value="all">All activity</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></select></label>
        <label className="filter-control"><span>Status</span><select value={draft.status} onChange={(event) => updateDraft("status", event.target.value)}><option value="all">All statuses</option><option value="COMPLETED">Completed</option><option value="PENDING">Pending</option><option value="REVERSED">Reversed</option></select></label>
        <label className="filter-control"><span>Sort by</span><select value={draft.sort} onChange={(event) => updateDraft("sort", event.target.value)}><option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option><option value="amount_desc">Largest amount</option><option value="amount_asc">Smallest amount</option></select></label>
        <div className="filter-actions"><button className="button button-primary" type="submit">Apply filters <ArrowRight size={16}/></button><button className="text-button" type="button" onClick={resetFilters}>Clear filters</button></div>
      </form>
    </section>
    <section className="portal-section transaction-results"><div className="portal-section-heading"><div><h2>Transaction history</h2><p>{range} · records from your linked sample accounts</p></div></div>
      {error && <div role="alert" className="form-error transaction-error">{error}</div>}
      {loading ? <div className="portal-table-state">Loading your transactions…</div> : transactions.length ? <><div className="transaction-table-wrap"><table className="transaction-table"><thead><tr><th>Transaction</th><th>Account</th><th>Counterparty</th><th>Date</th><th>Status</th><th className="amount-cell">Amount</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.transaction_id}><td><span className={`direction-icon ${transaction.direction}`}>{transaction.direction === "incoming" ? <ArrowDownLeft size={16}/> : <ArrowUpRight size={16}/>}</span><span className="transaction-primary"><strong>{transaction.merchant || (transaction.direction === "incoming" ? "Incoming transfer" : "Outgoing transfer")}</strong><small>{transaction.transaction_id}</small></span></td><td>{transaction.account_id}</td><td>{transaction.direction === "incoming" ? transaction.source_account : transaction.target_account}</td><td>{formatDate(transaction.timestamp)}</td><td><span className={`status-pill status-${transaction.status.toLowerCase()}`}>{transaction.status.toLowerCase()}</span></td><td className="amount-cell"><strong className={transaction.direction === "incoming" ? "amount-in" : ""}>{transaction.direction === "incoming" ? "+" : "−"}{formatCurrency(transaction.amount, transaction.currency)}</strong></td><td><Link href={`/dashboard/transactions/${encodeURIComponent(transaction.transaction_id)}`} className="table-open-link" aria-label={`View transaction ${transaction.transaction_id}`}><ArrowRight size={16}/></Link></td></tr>)}</tbody></table></div>
        <div className="pagination-row"><span>{range}</span><div><button type="button" className="button button-outline pagination-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loading}><ArrowLeft size={15}/>Previous</button><span className="pagination-page">Page {page} of {pages}</span><button type="button" className="button button-outline pagination-button" onClick={() => setPage((current) => Math.min(pages, current + 1))} disabled={page >= pages || loading}>Next<ArrowRight size={15}/></button></div></div>
      </> : <div className="portal-empty"><Search size={20}/><strong>No transactions match these filters.</strong><span>Change a filter or clear them to see the full history.</span><button className="text-button" type="button" onClick={resetFilters}>Clear filters</button></div>}
    </section>
    <p className="portal-demo-note">The dates, amounts, statuses, and account activity shown here are synthetic demonstration records.</p>
  </>;
}

export function CustomerTransactions() {
  return <PortalShell active="transactions" title="Transactions" subtitle="Search and review activity across your linked sample accounts."><TransactionsContent /></PortalShell>;
}
