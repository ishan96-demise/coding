"use client";

import { useEffect, useState } from "react";
import { Activity, Bot, ChevronRight, Fingerprint, GitFork, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { apiUrl } from "@/lib/api";
import type { AgentWidget } from "@/lib/types";

const icons = [ShieldCheck, GitFork, Fingerprint, Activity];

export function AgentStream({ account }: { account: string }) {
  const [widgets, setWidgets] = useState<AgentWidget[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setWidgets([]);
    setConnected(false);
    const source = new EventSource(apiUrl(`/api/stream/intelligence?account_id=${encodeURIComponent(account)}`));
    source.addEventListener("connected", () => setConnected(true));
    source.addEventListener("widget", (event) => {
      try {
        const item = JSON.parse((event as MessageEvent).data) as AgentWidget;
        setWidgets((current) => [item, ...current.filter((widget) => widget.event_id !== item.event_id)].slice(0, 16));
      } catch (error) { console.error("Invalid agent widget event", error); }
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [account]);

  const visible = widgets.filter((widget) => !account || widget.subject === account).slice(0, 5);
  return <div className="flex h-full min-h-[220px] flex-col">
    <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-2.5"><div className="flex items-center gap-2"><Bot size={14} className="text-cyan-200"/><span className="text-[10px] font-bold tracking-[.14em] text-slate-300">AGENT INTELLIGENCE</span></div><span className="flex items-center gap-1.5 text-[9px] text-slate-500"><i className={`h-1.5 w-1.5 rounded-full ${connected ? "signal-pulse bg-emerald-300" : "bg-amber-300"}`}/>{connected ? "SSE STREAM" : "RECONNECTING"}</span></div>
    <div className="terminal-scroll flex-1 space-y-2 overflow-y-auto p-3">
      {visible.map((widget, index) => <WidgetCard key={widget.event_id} widget={widget} index={index} />)}
      {visible.length === 0 && <div className="grid h-full min-h-[170px] place-items-center"><div className="max-w-[240px] text-center"><div className="mx-auto mb-2 grid h-8 w-8 place-items-center rounded-lg border border-white/[.07] bg-white/[.025] text-slate-600"><Bot size={15}/></div><div className="text-[11px] text-slate-400">Agent stream standing by</div><div className="mt-1 text-[10px] leading-relaxed text-slate-600">Ingested transactions will trigger network, graph, and behavior analysis widgets here.</div></div></div>}
    </div>
    <div className="border-t border-white/[.05] px-4 py-2 text-[9px] text-slate-600">Structured outputs · Pydantic schema · live graph evidence <ChevronRight size={10} className="inline"/></div>
  </div>;
}

function WidgetCard({ widget, index }: { widget: AgentWidget; index: number }) {
  const Icon = icons[index % icons.length];
  const high = widget.risk_level?.toUpperCase() === "HIGH RISK";
  const tone = high ? "text-rose-300 border-rose-400/15 bg-rose-400/[.06]" : widget.risk_level?.toUpperCase() === "WATCH" ? "text-amber-200 border-amber-300/15 bg-amber-300/[.05]" : "text-emerald-200 border-emerald-300/15 bg-emerald-300/[.04]";
  const components = Object.entries(widget.score_components || {}).flatMap(([group, values]) => Object.entries(values).map(([name, value]) => ({ group, name, value }))).slice(0, 6);
  const confidenceDisplay = widget.confidence === null ? "NOT CALIBRATED" : `${widget.confidence_label || "ANOMALY EVIDENCE STRENGTH"} · ${(widget.confidence * 100).toFixed(0)}%`;
  return <motion.article initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg border border-white/[.07] bg-[#0b1018] p-3">
    <div className="flex items-start gap-2.5"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-cyan-200/10 bg-cyan-200/[.05] text-cyan-200"><Icon size={13}/></span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><div className="truncate text-[10px] font-semibold text-slate-300">{widget.agent}</div><span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold tracking-wide ${tone}`}>{widget.risk_level} · {widget.score}/100</span></div><div className="mt-1 text-[10px] leading-relaxed text-slate-500">{widget.rationale}</div><div className="mt-2 flex items-center justify-between text-[9px] text-slate-600"><span>{widget.subject} · {confidenceDisplay}</span><span>{new Date(widget.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div>{components.length > 0 && <div className="mt-2 grid grid-cols-2 gap-1">{components.map(({ group, name, value }) => <div key={`${group}:${name}`} className="min-w-0 rounded border border-white/[.045] bg-white/[.02] px-1.5 py-1"><div className="truncate text-[7px] uppercase tracking-wider text-slate-700">{group.replaceAll("_", " ")} · {name.replaceAll("_", " ")}</div><div className="mt-0.5 truncate font-mono text-[9px] text-slate-400">{typeof value === "boolean" ? (value ? "yes" : "no") : typeof value === "number" ? value.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : value}</div></div>)}</div>}{widget.evidence?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{widget.evidence.slice(0, 3).map((evidence) => <span key={evidence} className="max-w-full truncate rounded bg-white/[.035] px-1.5 py-1 text-[8px] text-slate-500">{evidence}</span>)}</div>}</div></div>
  </motion.article>;
}
