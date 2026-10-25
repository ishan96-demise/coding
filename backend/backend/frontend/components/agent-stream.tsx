"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowUpRight, Bot, ChevronDown, ChevronUp, CircleAlert, EyeOff, Fingerprint, GitFork, Maximize2, Minimize2, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { apiUrl } from "@/lib/api";
import type { AgentWidget } from "@/lib/types";

type RiskFilter = "ALL" | "HIGH RISK" | "WATCH" | "SAFE";
type SortOrder = "NEWEST" | "HIGHEST SCORE";

export function AgentStream({ account, onInvestigate, onHide }: { account: string; onInvestigate: (account: string) => void; onHide: () => void }) {
  const [widgets, setWidgets] = useState<AgentWidget[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamIssue, setStreamIssue] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [snapshotTargetCount, setSnapshotTargetCount] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("ALL");
  const [sortOrder, setSortOrder] = useState<SortOrder>("NEWEST");
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(18);
  const [maximized, setMaximized] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const pendingWidgets = useRef<AgentWidget[]>([]);
  const flushTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearPending = () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
      pendingWidgets.current = [];
    };
    setWidgets([]);
    setConnected(false);
    setStreamIssue(false);
    setSnapshotLoaded(false);
    setSnapshotTargetCount(null);
    setVisibleLimit(18);
    clearPending();
    const streamUrl = account
      ? `/api/stream/intelligence?account_id=${encodeURIComponent(account)}`
      : "/api/stream/intelligence";
    const source = new EventSource(apiUrl(streamUrl));
    source.addEventListener("connected", () => { setConnected(true); setStreamIssue(false); });
    source.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          account_count?: number;
          complete?: boolean;
          widgets?: AgentWidget[];
        };
        setSnapshotTargetCount(Number.isFinite(payload.account_count) ? Number(payload.account_count) : null);
        if (Array.isArray(payload.widgets)) {
          if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
          flushTimer.current = null;
          const pending = pendingWidgets.current;
          pendingWidgets.current = [];
          setWidgets((current) => mergeWidgets(current, [...(payload.widgets || []), ...pending]));
        }
        setSnapshotLoaded(payload.complete !== false);
      } catch (error) { console.error("Invalid account explanation snapshot", error); }
    });
    source.addEventListener("widget", (event) => {
      try {
        const item = JSON.parse((event as MessageEvent).data) as AgentWidget;
        pendingWidgets.current.push(item);
        if (flushTimer.current === null) {
          flushTimer.current = window.setTimeout(() => {
            flushTimer.current = null;
            const batch = pendingWidgets.current;
            pendingWidgets.current = [];
            if (batch.length) setWidgets((current) => mergeWidgets(current, batch));
          }, 100);
        }
      } catch (error) { console.error("Invalid agent widget event", error); }
    });
    source.onerror = () => { setConnected(false); setStreamIssue(true); };
    return () => { source.close(); clearPending(); };
  }, [account, streamAttempt]);

  useEffect(() => { setVisibleLimit(18); }, [query, riskFilter, sortOrder]);

  useEffect(() => {
    if (!maximized) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [maximized]);

  const accountWidgets = useMemo(() => widgets.filter((widget) => !account || widget.subject === account), [widgets, account]);
  const accountRiskLevels = useMemo(() => {
    const risks = new Map<string, RiskFilter>();
    for (const widget of accountWidgets) risks.set(widget.subject, riskBand(widget));
    return Array.from(risks.values());
  }, [accountWidgets]);
  const counts = useMemo(() => ({
    high: accountRiskLevels.filter((risk) => risk === "HIGH RISK").length,
    watch: accountRiskLevels.filter((risk) => risk === "WATCH").length,
    safe: accountRiskLevels.filter((risk) => risk === "SAFE").length,
  }), [accountRiskLevels]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return accountWidgets
      .filter((widget) => riskFilter === "ALL" || riskBand(widget) === riskFilter)
      .filter((widget) => {
        if (!normalized) return true;
        const componentText = Object.entries(widget.score_components || {}).flatMap(([group, values]) => [group, ...Object.entries(values).flatMap(([name, value]) => [name, String(value)])]).join(" ");
        return [widget.subject, widget.agent, widget.rationale, ...(widget.evidence || []), componentText].join(" ").toLowerCase().includes(normalized);
      })
      .sort((left, right) => sortOrder === "HIGHEST SCORE"
        ? right.score - left.score || new Date(right.timestamp).valueOf() - new Date(left.timestamp).valueOf()
        : new Date(right.timestamp).valueOf() - new Date(left.timestamp).valueOf());
  }, [accountWidgets, query, riskFilter, sortOrder]);
  const displayed = visible.slice(0, visibleLimit);
  const toggleWidget = useCallback((eventId: string) => {
    setExpandedEvent((current) => current === eventId ? null : eventId);
  }, []);

  const rootClass = maximized
    ? "fixed inset-3 z-[70] min-h-0"
    : minimized
      ? "h-[58px] min-h-0"
      : "h-[clamp(440px,68vh,760px)] min-h-[340px]";

  const panel = <section aria-label="Explainable signal workbench" aria-modal={maximized} role={maximized ? "dialog" : undefined} className={`glass-panel panel-glow relative flex min-w-0 flex-col overflow-hidden rounded-lg ${rootClass}`}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/[.07] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-cyan-200/15 bg-cyan-200/[.06] text-cyan-100"><Bot size={17}/></span>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-[12px] font-bold tracking-[.13em] text-slate-200">EXPLAINABLE SIGNAL REVIEW</h2><span className="rounded border border-white/[.08] px-1.5 py-0.5 text-[9px] font-mono text-slate-500">GRAPH + RULE EVIDENCE</span></div><p className="mt-1 text-[11px] text-slate-500">Per-account network, graph, and behavior evidence · scores are not fraud probabilities</p></div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="mr-1 flex items-center gap-1.5 text-[10px] text-slate-500"><i className={`h-1.5 w-1.5 rounded-full ${connected ? "signal-pulse bg-emerald-300" : streamIssue ? "bg-rose-300" : "bg-amber-300"}`}/>{!connected ? streamIssue ? "STREAM INTERRUPTED · RETRYING" : "LOADING SIGNALS" : snapshotLoaded ? `${accountRiskLevels.length} ACCOUNTS EXPLAINED · LIVE` : snapshotTargetCount !== null ? `${accountRiskLevels.length}/${snapshotTargetCount} ACCOUNTS EXPLAINED` : "BUILDING ACCOUNT EXPLANATIONS"}</span>
          {!connected && streamIssue && <button type="button" onClick={() => setStreamAttempt((attempt) => attempt + 1)} className="h-8 rounded-md border border-rose-200/20 px-2 text-[10px] font-semibold text-rose-100 transition hover:bg-rose-200/[.08]">Retry stream</button>}
          <button type="button" aria-label={minimized ? "Expand signal feed" : "Minimize signal feed"} title={minimized ? "Expand feed" : "Minimize feed"} onClick={() => setMinimized((value) => !value)} className="grid h-8 w-8 place-items-center rounded-md border border-white/[.08] text-slate-400 transition hover:border-cyan-200/20 hover:text-cyan-100">{minimized ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button>
          <button type="button" aria-label={maximized ? "Restore signal feed size" : "Maximize signal feed"} title={maximized ? "Restore panel size · Esc" : "Maximize feed"} onClick={() => setMaximized((value) => !value)} className="grid h-8 w-8 place-items-center rounded-md border border-white/[.08] text-slate-400 transition hover:border-cyan-200/20 hover:text-cyan-100">{maximized ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button>
          <button type="button" aria-label="Hide signal feed" title="Hide feed; restore it from the page toolbar" onClick={onHide} className="grid h-8 w-8 place-items-center rounded-md border border-white/[.08] text-slate-400 transition hover:border-rose-300/20 hover:text-rose-200"><EyeOff size={14}/></button>
        </div>
      </header>

      {!minimized && <>
        <div className="grid shrink-0 grid-cols-2 gap-px border-b border-white/[.06] bg-white/[.045] md:grid-cols-4">
          <SignalMetric label="ACCOUNTS EXPLAINED" value={accountRiskLevels.length} detail={snapshotLoaded ? "CURRENT GRAPH SNAPSHOT" : snapshotTargetCount !== null ? `OF ${snapshotTargetCount} · BUILDING` : "BUILDING SNAPSHOT"} tone="text-cyan-100"/>
          <SignalMetric label="HIGH RISK" value={counts.high} detail="REVIEW FIRST" tone="text-rose-300"/>
          <SignalMetric label="WATCH" value={counts.watch} detail="ELEVATED EVIDENCE" tone="text-amber-200"/>
          <SignalMetric label="SAFE / LOWER RANK" value={counts.safe} detail="NO HIGH-RISK LABEL" tone="text-emerald-200"/>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[.06] bg-black/10 p-3">
          <label className="relative min-w-[210px] flex-1"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search account, signal, or evidence…" aria-label="Search explainable signals" className="h-9 w-full rounded-md border border-white/[.09] bg-[#080c13] pl-9 pr-3 text-[12px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-cyan-200/30"/></label>
          <div role="group" aria-label="Filter by risk level" className="flex flex-wrap items-center gap-1 rounded-md border border-white/[.06] bg-black/15 p-1">
            {(["ALL", "HIGH RISK", "WATCH", "SAFE"] as const).map((filter) => <button key={filter} type="button" aria-pressed={riskFilter === filter} onClick={() => setRiskFilter(filter)} className={`h-7 rounded px-2 text-[10px] font-semibold transition ${riskFilter === filter ? "bg-cyan-200/[.1] text-cyan-100" : "text-slate-500 hover:bg-white/[.04] hover:text-slate-200"}`}>{filter}</button>)}
          </div>
          <label className="flex h-9 items-center gap-1.5 rounded-md border border-white/[.08] bg-[#080c13] px-2.5 text-[10px] text-slate-500"><SlidersHorizontal size={12}/><span className="sr-only">Sort signals</span><select aria-label="Sort signals" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)} className="bg-transparent text-[10px] text-slate-300 outline-none"><option value="NEWEST">Newest first</option><option value="HIGHEST SCORE">Highest score</option></select></label>
          <span className="ml-auto text-[10px] font-mono text-slate-600">SHOWING {displayed.length} OF {visible.length}</span>
        </div>

        <div className="terminal-scroll min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-3 md:p-4">
          {displayed.map((widget) => <WidgetCard key={widget.event_id} widget={widget} expanded={expandedEvent === widget.event_id} onToggle={toggleWidget} onInvestigate={onInvestigate}/>) }
          {displayed.length < visible.length && <div className="flex flex-wrap items-center justify-center gap-2 py-2"><button type="button" onClick={() => setVisibleLimit((current) => Math.min(current + 18, visible.length))} className="h-8 rounded-md border border-cyan-200/15 bg-cyan-200/[.045] px-3 text-[9px] font-semibold tracking-wide text-cyan-100 transition hover:bg-cyan-200/[.09]">LOAD NEXT {Math.min(18, visible.length - displayed.length)} SIGNALS</button><button type="button" onClick={() => setVisibleLimit(visible.length)} className="h-8 rounded-md px-2 text-[9px] text-slate-500 transition hover:text-slate-200">SHOW ALL {visible.length}</button></div>}
          {visible.length === 0 && <div className="grid min-h-[220px] place-items-center rounded-lg border border-dashed border-white/[.08] bg-black/10 px-6 text-center"><div className="max-w-sm"><div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg border border-white/[.08] bg-white/[.025] text-slate-500"><CircleAlert size={18}/></div><div className="text-[13px] font-medium text-slate-300">{accountWidgets.length ? "No signals match these filters" : connected && !snapshotLoaded ? "Building account explanations" : connected ? "No accounts are available in this graph" : streamIssue ? "The intelligence stream is unavailable" : "Loading account explanations"}</div><p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{accountWidgets.length ? "Clear the search or choose another risk level to review more evidence." : connected && !snapshotLoaded ? "The workbench is calculating a network, graph, and behavior explanation for each account." : connected ? "Load transaction data to create account-level explanations." : streamIssue ? "The browser is retrying the live feed. Use Retry stream if the connection does not recover." : "The workbench is waiting for the initial account snapshot."}</p></div></div>}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/[.06] px-4 py-2.5 text-[10px] text-slate-500"><span><ShieldCheck size={12} className="mr-1.5 inline text-cyan-200/70"/>Rule features and graph anomaly ranking · confidence is uncalibrated evidence strength</span><span className="font-mono text-[9px] text-slate-600">SSE · {connected ? "CONNECTED" : "RETRYING"}</span></footer>
      </>}
    </section>;
  if (!maximized) return panel;
  return createPortal(<><div aria-hidden="true" className="fixed inset-0 z-[69] bg-black/75 backdrop-blur-sm"/>{panel}</>, document.body);
}

function SignalMetric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: string }) {
  return <div className="bg-[#0b1018] px-3.5 py-3"><div className="text-[9px] font-bold tracking-[.13em] text-slate-600">{label}</div><div className={`mt-1 font-mono text-[19px] font-semibold tabular-nums ${tone}`}>{value}</div><div className="mt-0.5 text-[9px] tracking-wide text-slate-600">{detail}</div></div>;
}

const WidgetCard = memo(function WidgetCard({ widget, expanded, onToggle, onInvestigate }: { widget: AgentWidget; expanded: boolean; onToggle: (eventId: string) => void; onInvestigate: (account: string) => void }) {
  const high = riskBand(widget) === "HIGH RISK";
  const watch = riskBand(widget) === "WATCH";
  const Icon = /behavior/i.test(widget.agent) ? Fingerprint : /graph|structure/i.test(widget.agent) ? GitFork : Activity;
  const tone = high ? "text-rose-200 border-rose-400/20 bg-rose-400/[.07]" : watch ? "text-amber-100 border-amber-300/20 bg-amber-300/[.06]" : "text-emerald-100 border-emerald-300/20 bg-emerald-300/[.05]";
  const components = Object.entries(widget.score_components || {}).flatMap(([group, values]) => Object.entries(values).map(([name, value]) => ({ group, name, value })));
  const confidenceDisplay = typeof widget.confidence === "number"
    ? `${widget.confidence_label || "EVIDENCE STRENGTH"} · ${(widget.confidence * 100).toFixed(0)}% · UNCALIBRATED`
    : "EVIDENCE STRENGTH · NOT CALIBRATED";

  return <article className={`rounded-lg border bg-[#0b1018] transition-colors duration-150 ${expanded ? "border-cyan-200/20 shadow-[0_0_28px_rgba(117,230,220,.04)]" : "border-white/[.07] hover:border-white/[.12]"}`}>
    <div className="flex flex-wrap items-start gap-3 p-3.5 md:p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-cyan-200/10 bg-cyan-200/[.05] text-cyan-100"><Icon size={17}/></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span className="text-[12px] font-semibold text-slate-200">{widget.agent}</span><span className={`rounded border px-2 py-1 text-[10px] font-bold tracking-wide ${tone}`}>{widget.risk_level} · {widget.score}/100</span></div>
        <p className="mt-2 max-w-5xl text-[12px] leading-relaxed text-slate-400">{widget.rationale}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500"><span className="font-mono text-cyan-100/75">{widget.subject}</span><span>{confidenceDisplay}</span><time dateTime={widget.timestamp}>{formatTimestamp(widget.timestamp)}</time></div>
        {widget.evidence?.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{widget.evidence.slice(0, expanded ? undefined : 4).map((evidence) => <span key={evidence} className="max-w-full rounded border border-white/[.06] bg-white/[.025] px-2 py-1 text-[10px] leading-snug text-slate-400">{evidence}</span>)}</div>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button type="button" onClick={() => onToggle(widget.event_id)} aria-expanded={expanded} className="flex h-8 items-center gap-1.5 rounded-md border border-white/[.08] px-2.5 text-[10px] font-semibold text-slate-400 transition hover:border-cyan-200/20 hover:text-cyan-100">{expanded ? "LESS DETAIL" : "EXPLAIN SIGNAL"}{expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}</button>
        <button type="button" onClick={() => onInvestigate(widget.subject)} className="flex h-8 items-center gap-1.5 rounded-md border border-cyan-200/15 bg-cyan-200/[.05] px-2.5 text-[10px] font-semibold text-cyan-100 transition hover:bg-cyan-200/[.1]">INVESTIGATE<ArrowUpRight size={13}/></button>
      </div>
    </div>

    {expanded && <div className="border-t border-white/[.06] bg-black/15 px-3.5 py-3 md:px-4 md:py-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(260px,.8fr)]">
        <div><div className="mb-2 text-[10px] font-bold tracking-[.14em] text-cyan-100/65">OBSERVED EVIDENCE</div>{widget.evidence?.length ? <ul className="space-y-2">{widget.evidence.map((evidence, index) => <li key={`${index}-${evidence}`} className="flex gap-2 text-[11px] leading-relaxed text-slate-400"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-cyan-200/70"/>{evidence}</li>)}</ul> : <p className="text-[11px] text-slate-600">No evidence details were included in this stream event.</p>}<p className="mt-3 border-l-2 border-amber-300/30 pl-2.5 text-[10px] leading-relaxed text-slate-500">The displayed score ranks observed indicators. The evidence-strength percentage is uncalibrated and must not be read as the probability of fraud.</p></div>
        <div><div className="mb-2 text-[10px] font-bold tracking-[.14em] text-cyan-100/65">SCORE COMPONENTS</div>{components.length ? <div className="grid gap-1.5 sm:grid-cols-2">{components.map(({ group, name, value }) => <div key={`${group}:${name}`} className="rounded-md border border-white/[.06] bg-white/[.02] px-2.5 py-2"><div className="text-[9px] uppercase tracking-wider text-slate-600">{group.replaceAll("_", " ")} · {name.replaceAll("_", " ")}</div><div className="mt-1 font-mono text-[12px] text-slate-200">{formatComponent(value)}</div></div>)}</div> : <p className="text-[11px] text-slate-600">This event did not include numeric score components.</p>}</div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[.06] pt-2.5 text-[10px] text-slate-600"><span>EVENT {widget.event_id} · {widget.widget_type.replaceAll("-", " ").toUpperCase()}</span><button type="button" onClick={() => onInvestigate(widget.subject)} className="inline-flex items-center gap-1.5 font-semibold text-cyan-100/75 hover:text-cyan-100">OPEN ACCOUNT NETWORK <ArrowUpRight size={12}/></button></div>
    </div>}
  </article>;
});

function mergeWidgets(current: AgentWidget[], incoming: AgentWidget[]) {
  const merged = new Map<string, AgentWidget>();
  for (const widget of current) merged.set(`${widget.subject}\u0000${widget.agent}`, widget);
  for (const widget of incoming) merged.set(`${widget.subject}\u0000${widget.agent}`, widget);
  return Array.from(merged.values());
}

function riskBand(widget: AgentWidget): RiskFilter {
  const level = widget.risk_level?.toUpperCase() || "";
  if (level.includes("HIGH") || level.includes("FRAUD")) return "HIGH RISK";
  if (level.includes("WATCH")) return "WATCH";
  return "SAFE";
}

function formatComponent(value: number | boolean) {
  if (typeof value === "boolean") return value ? "YES" : "NO";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Timestamp unavailable" : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" });
}
