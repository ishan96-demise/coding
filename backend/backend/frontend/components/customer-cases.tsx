"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BriefcaseBusiness, LoaderCircle } from "lucide-react";
import { PortalShell } from "@/components/portal-shell";

type CustomerCase = {
  case_id: string;
  account_id: string;
  transaction_id: string;
  status: string;
  priority: string;
  created_at: string;
  transaction_timestamp: string;
  transaction_status: string;
  amount: number;
  currency: string;
  merchant?: string | null;
};

const dateLabel = (value: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const money = (amount: number, currency: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
const humanStatus = (status: string) => status.replace(/[_-]+/g, " ").toLowerCase();

function CasesContent() {
  const [cases, setCases] = useState<CustomerCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/portal/cases", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Your reported cases could not be loaded.");
        return payload;
      })
      .then((payload) => setCases(Array.isArray(payload.cases) ? payload.cases as CustomerCase[] : []))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Your reported cases could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  return <>
    <div className="customer-cases-intro"><div><p>Your reports are attached to analyst review cases. This page shows only cases you submitted.</p></div><Link className="button button-primary" href="/dashboard/transactions">Find a transaction to report <ArrowRight size={16}/></Link></div>
    {loading ? <div className="portal-state-card"><LoaderCircle size={20} className="spin"/> Loading your cases…</div> : error ? <div className="portal-state-card portal-state-error" role="alert">{error}</div> : cases.length ? <div className="customer-case-list">{cases.map((item) => <article className="customer-case-card" key={item.case_id}>
      <div className="customer-case-icon"><BriefcaseBusiness size={19}/></div>
      <div className="customer-case-main"><div className="customer-case-title"><div><h2>{item.merchant || "Reported transaction"}</h2><p>{item.transaction_id} · {item.account_id}</p></div><span className={`status-pill status-${humanStatus(item.status).replace(/ /g, "-")}`}>{humanStatus(item.status)}</span></div>
        <p className="customer-case-description">{money(item.amount, item.currency)} · Transaction {humanStatus(item.transaction_status)} · Reported {dateLabel(item.created_at)}</p>
        <div className="customer-case-actions"><span>Case {item.case_id}</span><Link href={`/dashboard/transactions/${encodeURIComponent(item.transaction_id)}`}>View transaction <ArrowRight size={14}/></Link></div>
      </div>
    </article>)}</div> : <div className="portal-empty customer-cases-empty"><BriefcaseBusiness size={24}/><strong>No reported cases yet</strong><span>Open a transaction and choose “Report this transaction” to send it to the analyst case queue.</span><Link className="button button-outline" href="/dashboard/transactions">Review transactions <ArrowRight size={15}/></Link></div>}
  </>;
}

export function CustomerCases() {
  return <PortalShell active="cases" title="My cases" subtitle="Track transactions you have reported for analyst review."><CasesContent /></PortalShell>;
}
