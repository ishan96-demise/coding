"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowDownLeft, ArrowUpRight, CircleCheck, LoaderCircle, Send } from "lucide-react";
import { PortalShell } from "@/components/portal-shell";

type Transaction = { transaction_id: string; account_id: string; source_account: string; target_account: string; amount: number; currency: string; timestamp: string; status: string; direction: "incoming" | "outgoing"; merchant?: string | null; location?: string | null };
const money = (amount: number, currency: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
const when = (value: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeStyle: "short" }).format(new Date(value));

function DetailContent() {
  const params = useParams<{ transactionId: string }>();
  const transactionId = decodeURIComponent(params.transactionId);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportResult, setReportResult] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/portal/transactions/${encodeURIComponent(transactionId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.detail || "Transaction details could not be loaded."); return payload; })
      .then((payload) => setTransaction(payload.transaction as Transaction))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Transaction details could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [transactionId]);

  const report = async () => {
    setReporting(true); setError(""); setReportResult("");
    try {
      const response = await fetch(`/api/portal/transactions/${encodeURIComponent(transactionId)}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }), cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "The report could not be sent.");
      setReportResult(`${payload.message} Case ${payload.case_id}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The report could not be sent.");
    } finally { setReporting(false); }
  };

  return <>
    <Link className="portal-inline-link detail-back-link" href="/dashboard/transactions"><ArrowLeft size={16}/> Back to transactions</Link>
    {loading ? <div className="portal-state-card"><LoaderCircle size={20} className="spin"/> Loading transaction details…</div> : error && !transaction ? <div className="portal-state-card portal-state-error" role="alert"><strong>{error}</strong></div> : transaction && <>
      <section className="detail-card">
        <div className="detail-card-heading"><div><span className={`direction-icon ${transaction.direction}`}>{transaction.direction === "incoming" ? <ArrowDownLeft size={19}/> : <ArrowUpRight size={19}/>}</span><div><p className="welcome-label">{transaction.direction === "incoming" ? "Incoming transfer" : "Outgoing transfer"}</p><h2>{transaction.merchant || "Account transfer"}</h2></div></div><span className={`status-pill status-${transaction.status.toLowerCase()}`}>{transaction.status.toLowerCase()}</span></div>
        <strong className={`detail-amount ${transaction.direction === "incoming" ? "amount-in" : ""}`}>{transaction.direction === "incoming" ? "+" : "−"}{money(transaction.amount, transaction.currency)}</strong>
        <dl className="detail-facts"><div><dt>Transaction ID</dt><dd>{transaction.transaction_id}</dd></div><div><dt>Date and time</dt><dd>{when(transaction.timestamp)}</dd></div><div><dt>Your account</dt><dd>{transaction.account_id}</dd></div><div><dt>Counterparty account</dt><dd>{transaction.direction === "incoming" ? transaction.source_account : transaction.target_account}</dd></div><div><dt>Location</dt><dd>{transaction.location || "Not provided"}</dd></div><div><dt>Data source</dt><dd>Synthetic demonstration record</dd></div></dl>
      </section>
      <section className="report-card"><div><p className="eyebrow">Need a closer look?</p><h2>Report this transaction</h2><p>Your note will be attached to a review case in the analyst queue. This demo does not contact a bank or freeze a payment.</p></div><label className="report-note-label">What should the review team know?<textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1200} rows={4} placeholder="Add a short note (optional)" /></label>{error && <p role="alert" className="form-error">{error}</p>}{reportResult && <p role="status" className="report-success"><CircleCheck size={18}/>{reportResult} <Link href="/dashboard/cases">View my cases <ArrowRight size={14}/></Link></p>}<button className="button button-primary" type="button" onClick={report} disabled={reporting}>{reporting ? <><LoaderCircle size={16} className="spin"/> Sending report…</> : <>Report transaction <Send size={16}/></>}</button></section>
      <p className="portal-demo-note">This transaction is synthetic and does not represent real money or bank activity.</p>
    </>}
  </>;
}

export function CustomerTransactionDetail() {
  return <PortalShell active="transactions" title="Transaction details" subtitle="Review the record linked to your sample account."><DetailContent /></PortalShell>;
}
