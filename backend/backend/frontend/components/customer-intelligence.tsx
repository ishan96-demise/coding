"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, CircleCheck, GitFork, LoaderCircle, ShieldCheck } from "lucide-react";
import { PortalShell } from "@/components/portal-shell";

type GraphNode = { id: string; label: string; kind: "account" | "external" };
type GraphEdge = { source: string; target: string; transaction_count: number; amount_inr: number; evidence_transaction_ids: string[] };
type Signal = { key: string; title: string; matched: boolean; explanation: string; evidence_transaction_ids: string[] };
type InsightAccount = {
  account_id: string;
  name: string;
  currency: string;
  transaction_count: number;
  incoming_count: number;
  outgoing_count: number;
  pending_count: number;
  reversed_count: number;
  incoming_total: number;
  outgoing_total: number;
  signals: Signal[];
};
type Intelligence = { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; accounts: InsightAccount[]; disclaimer: string };

const money = (amount: number, code: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(amount);

function CustomerNetwork({ graph }: { graph: Intelligence["graph"] }) {
  const accountNodes = graph.nodes.filter((node) => node.kind === "account");
  const externalNode = graph.nodes.find((node) => node.kind === "external");
  const positions = new Map<string, { x: number; y: number }>();
  accountNodes.forEach((node, index) => {
    let position: { x: number; y: number };
    if (accountNodes.length === 1) position = { x: 380, y: 207 };
    else if (accountNodes.length === 2) position = { x: index === 0 ? 190 : 570, y: 205 };
    else {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / accountNodes.length;
      position = { x: 380 + Math.cos(angle) * 250, y: 170 + Math.sin(angle) * 78 };
    }
    positions.set(node.id, position);
  });
  if (externalNode) positions.set(externalNode.id, { x: 380, y: 65 });

  return <div className="customer-graph-wrap">
    {accountNodes.length ? <svg className="customer-graph" viewBox="0 0 760 285" role="img" aria-label="Transaction links between your linked accounts and outside activity">
      <defs><marker id="customer-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--page-accent)" /></marker></defs>
      {graph.edges.map((edge, index) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;
        return <g key={`${edge.source}-${edge.target}-${index}`}>
          <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="var(--page-accent)" strokeOpacity=".52" strokeWidth={Math.min(4, 1.5 + edge.transaction_count / 4)} markerEnd="url(#customer-graph-arrow)" />
          <title>{edge.transaction_count} transaction(s) in this direction</title>
          <text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 8} className="customer-graph-edge-label">{edge.transaction_count}</text>
        </g>;
      })}
      {graph.nodes.map((node) => {
        const point = positions.get(node.id);
        if (!point) return null;
        const external = node.kind === "external";
        return <g key={node.id}>
          <circle cx={point.x} cy={point.y} r={external ? 26 : 31} className={external ? "customer-graph-external" : "customer-graph-account"} />
          <text x={point.x} y={point.y + 5} textAnchor="middle" className="customer-graph-node-symbol">{external ? "↔" : String(node.label).slice(-3)}</text>
          <text x={point.x} y={point.y + (external ? 45 : 51)} textAnchor="middle" className="customer-graph-node-label">{node.label}</text>
        </g>;
      })}
    </svg> : <div className="portal-empty"><strong>No linked accounts yet</strong><span>The graph will appear when account activity is available.</span></div>}
    <div className="customer-graph-legend"><span><i className="own"/>Your linked accounts</span><span><i className="outside"/>Outside your accounts, grouped</span></div>
  </div>;
}

function SignalCard({ account }: { account: InsightAccount }) {
  const matchedCount = account.signals.filter((signal) => signal.matched).length;
  return <article className="customer-insight-card">
    <div className="customer-insight-heading"><div><span className="account-icon"><GitFork size={18}/></span><div><h3>{account.name}</h3><p>{account.account_id} · {account.transaction_count} transactions</p></div></div><span className={`signal-count ${matchedCount ? "attention" : "clear"}`}>{matchedCount ? `${matchedCount} to review` : "No rule matches"}</span></div>
    <div className="customer-account-summary"><span>{account.incoming_count} incoming · {money(account.incoming_total, account.currency)}</span><span>{account.outgoing_count} outgoing · {money(account.outgoing_total, account.currency)}</span></div>
    <div className="customer-signal-list" aria-label={`Explainable signals for ${account.account_id}`}>
      {account.signals.map((signal) => <section key={signal.key} className={`customer-signal-row ${signal.matched ? "matched" : ""}`}>
        <span className="customer-signal-icon">{signal.matched ? <CircleAlert size={17}/> : <CircleCheck size={17}/>}</span>
        <div className="customer-signal-content"><strong>{signal.title}</strong><p>{signal.explanation}</p>
          {signal.evidence_transaction_ids.length > 0 && <div className="customer-evidence-links"><span>Evidence:</span>{signal.evidence_transaction_ids.map((id) => <Link key={id} href={`/dashboard/transactions/${encodeURIComponent(id)}`}>{id}</Link>)}</div>}
        </div>
      </section>)}
    </div>
  </article>;
}

function IntelligenceContent() {
  const [data, setData] = useState<Intelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/portal/intelligence", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Your account intelligence could not be loaded.");
        return payload as Intelligence;
      })
      .then(setData)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Your account intelligence could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  if (loading) return <div className="portal-state-card"><LoaderCircle size={20} className="spin"/> Loading your account network…</div>;
  if (error || !data) return <div className="portal-state-card portal-state-error" role="alert">{error || "Your account intelligence could not be loaded."}</div>;
  const reviewedTransactions = data.accounts.reduce((sum, account) => sum + account.transaction_count, 0);
  const activeSignals = data.accounts.reduce((sum, account) => sum + account.signals.filter((signal) => signal.matched).length, 0);

  return <>
    <section className="portal-overview-cards" aria-label="Your network summary">
      <article className="summary-card"><span className="summary-icon"><GitFork size={19}/></span><span className="summary-label">Your linked accounts</span><strong>{data.accounts.length}</strong><small>Only accounts assigned to your login</small></article>
      <article className="summary-card"><span className="summary-icon"><ShieldCheck size={19}/></span><span className="summary-label">Transactions reviewed</span><strong>{reviewedTransactions}</strong><small>Records touching your accounts</small></article>
      <article className="summary-card"><span className="summary-icon"><CircleAlert size={19}/></span><span className="summary-label">Rule matches</span><strong>{activeSignals}</strong><small>Evidence indicators to inspect</small></article>
    </section>

    <section className="portal-section customer-network-panel"><div className="portal-section-heading"><div><h2>Your transaction network</h2><p>Transfers between your linked accounts and outside activity grouped without exposing outside account IDs.</p></div></div><CustomerNetwork graph={data.graph}/></section>

    <section className="portal-section"><div className="portal-section-heading"><div><h2>Explainable account signals</h2><p>Every linked account is checked against the same visible rules. Open an evidence link to inspect the transaction.</p></div><Link className="portal-inline-link" href="/dashboard/transactions">All transactions <ArrowRight size={15}/></Link></div>
      {data.accounts.length ? <div className="customer-insight-grid">{data.accounts.map((account) => <SignalCard key={account.account_id} account={account}/>)}</div> : <div className="portal-empty">No linked accounts are available for review.</div>}
      <p className="portal-demo-note">{data.disclaimer}</p>
    </section>
  </>;
}

export function CustomerIntelligence() {
  return <PortalShell active="intelligence" title="Network & signals" subtitle="Explore the transaction graph and review evidence for every account linked to your workspace."><IntelligenceContent /></PortalShell>;
}
