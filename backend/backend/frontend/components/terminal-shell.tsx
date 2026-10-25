"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, AlertTriangle, ArrowDownLeft, ArrowDownRight, ArrowUpRight, Command, Database, Eye, Globe2, Layers3, LogOut, Menu, Network, Radio, RotateCcw, Search, Settings2, Shield, ShieldCheck, Sparkles, Undo2, Users, WalletCards, Wifi } from "lucide-react";
import { CommandPalette } from "@/components/command-palette";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BorderBeam } from "@/components/ui/border-beam";
import { ErrorBoundary } from "@/components/error-boundary";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { apiUrl, fetchIntelligence, fetchRecentTransactions } from "@/lib/api";
import type { IntelligenceSnapshot, Transaction } from "@/lib/types";

const AgentStream = dynamic(() => import("@/components/agent-stream").then((module) => module.AgentStream), {
  ssr: false,
  loading: () => <Panel className="grid min-h-[340px] place-items-center"><LoadingPanel label="Opening signal workbench…"/></Panel>,
});
const CaseQueue = dynamic(() => import("@/components/case-queue").then((module) => module.CaseQueue), {
  ssr: false,
  loading: () => <Panel className="grid min-h-[360px] place-items-center"><LoadingPanel label="Opening case queue…"/></Panel>,
});
const NetworkGraph = dynamic(() => import("@/components/network-graph").then((module) => module.NetworkGraph), {
  ssr: false,
  loading: () => <div className="grid h-full min-h-[420px] place-items-center bg-[#070b12]"><LoadingPanel label="Preparing the network view…"/></div>,
});
const TerminalChart = dynamic(() => import("@/components/terminal-chart").then((module) => module.TerminalChart), {
  ssr: false,
  loading: () => <div className="grid h-full min-h-[220px] place-items-center"><LoadingPanel label="Preparing flow analysis…"/></div>,
});

type View = "overview" | "networks" | "agents" | "cases";
type WorkspaceModule = "flow" | "transactions";
type OperatorProfile = { name: string; role: string; organization: string; active_cases: number; total_cases: number; system: string };
type ProviderStatus = { configured: boolean; webhook_ready: boolean; historical_sync_ready: boolean };
type GNNSignal = { available?: boolean; score?: number | null; confidence?: number; confidence_label?: string; confidence_basis?: string; confidence_is_probability?: boolean; model?: string; error?: string; evidence?: string[]; feature_deviations?: { feature: string; z_score: number; direction: string }[] };
type WorkspaceCheckpoint = {
  view: View;
  workspaceModule: WorkspaceModule;
  selectedAccount: string;
  analysis: AccountAnalysis | null;
  networkRiskHidden: boolean;
  agentFeedHidden: boolean;
  compact: boolean;
};
type AccountAnalysis = {
  account_id: string;
  risk_score: number;
  status: string;
  risk_explanation?: string;
  gnn?: GNNSignal;
  score_components?: Record<string, number | boolean>;
  explanation?: {
    score_type: string;
    is_probability: boolean;
    method: string;
    summary: string;
    risk_leader?: string;
    account_drivers: { factor: string; points: number }[];
    network_adjustments?: Record<string, number | boolean>;
    score_math?: {
      base_label: string;
      base_account_id: string;
      base_score: number;
      network_uplift: number;
      network_score: number;
      capped_at: number;
    };
  };
  network?: {
    account_count?: number;
    explanation?: string[];
    observed_routes?: string[];
    observed_countries?: string[];
    observed_locations?: string[];
    score_components?: Record<string, number | boolean>;
  };
  shared_devices?: { device_id: string; accounts: string[] }[];
  transactions?: Transaction[];
};

async function fetchOperatorProfile(signal?: AbortSignal): Promise<OperatorProfile> {
  const response = await fetch(apiUrl("/api/profile"), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Profile API returned ${response.status}`);
  return response.json() as Promise<OperatorProfile>;
}

const navigation: { key: View; label: string; icon: typeof Activity }[] = [
  { key: "overview", label: "Intelligence", icon: Activity },
  { key: "networks", label: "Fraud networks", icon: Network },
  { key: "agents", label: "Explainable signals", icon: Sparkles },
  { key: "cases", label: "Case queue", icon: WalletCards },
];

export function TerminalShell() {
  const [view, setView] = useState<View>("overview");
  const [workspaceModule, setWorkspaceModule] = useState<WorkspaceModule>("transactions");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [snapshot, setSnapshot] = useState<IntelligenceSnapshot | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<"loading" | "ready" | "error">("loading");
  const [apiError, setApiError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("ACC_097");
  const [analysis, setAnalysis] = useState<AccountAnalysis | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [profileStatus, setProfileStatus] = useState<"loading" | "ready" | "error">("loading");
  const [signedInUser, setSignedInUser] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [sourceSync, setSourceSync] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [networkRiskHidden, setNetworkRiskHidden] = useState(false);
  const [agentFeedHidden, setAgentFeedHidden] = useState(false);
  const undoHistory = useRef<WorkspaceCheckpoint[]>([]);
  const analysisRequest = useRef(0);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileInitials = getInitials(signedInUser || profile?.name || "FS");

  const rememberWorkspace = useCallback(() => {
    undoHistory.current.push({ view, workspaceModule, selectedAccount, analysis, networkRiskHidden, agentFeedHidden, compact });
    if (undoHistory.current.length > 40) undoHistory.current.shift();
    setCanUndo(true);
  }, [view, workspaceModule, selectedAccount, analysis, networkRiskHidden, agentFeedHidden, compact]);

  const navigateToView = useCallback((next: View) => {
    if (next === view) return;
    rememberWorkspace();
    setView(next);
  }, [view, rememberWorkspace]);

  const changeWorkspaceModule = useCallback((next: WorkspaceModule) => {
    if (next === workspaceModule) return;
    rememberWorkspace();
    setWorkspaceModule(next);
  }, [workspaceModule, rememberWorkspace]);

  const hideRiskMonitor = useCallback((hidden: boolean) => {
    if (hidden === networkRiskHidden) return;
    rememberWorkspace();
    setNetworkRiskHidden(hidden);
  }, [networkRiskHidden, rememberWorkspace]);

  const hideAgentFeed = useCallback((hidden: boolean) => {
    if (hidden === agentFeedHidden) return;
    rememberWorkspace();
    setAgentFeedHidden(hidden);
  }, [agentFeedHidden, rememberWorkspace]);

  const toggleCompactSidebar = useCallback(() => {
    rememberWorkspace();
    setCompact((value) => !value);
  }, [rememberWorkspace]);

  const undoWorkspace = useCallback(() => {
    const previous = undoHistory.current.pop();
    if (!previous) return;
    analysisRequest.current += 1;
    setView(previous.view);
    setWorkspaceModule(previous.workspaceModule);
    setSelectedAccount(previous.selectedAccount);
    setAnalysis(previous.analysis);
    setNetworkRiskHidden(previous.networkRiskHidden);
    setAgentFeedHidden(previous.agentFeedHidden);
    setCompact(previous.compact);
    setCanUndo(undoHistory.current.length > 0);
  }, []);

  const resetWorkspace = useCallback(() => {
    if (view === "overview" && workspaceModule === "transactions" && selectedAccount === "ACC_097" && analysis === null && !networkRiskHidden && !agentFeedHidden && !compact) return;
    rememberWorkspace();
    analysisRequest.current += 1;
    setView("overview");
    setWorkspaceModule("transactions");
    setSelectedAccount("ACC_097");
    setAnalysis(null);
    setNetworkRiskHidden(false);
    setAgentFeedHidden(false);
    setCompact(false);
  }, [view, workspaceModule, selectedAccount, analysis, networkRiskHidden, agentFeedHidden, compact, rememberWorkspace]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrowViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const handleUndoShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z" || !canUndo) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      undoWorkspace();
    };
    window.addEventListener("keydown", handleUndoShortcut);
    return () => window.removeEventListener("keydown", handleUndoShortcut);
  }, [canUndo, undoWorkspace]);

  useEffect(() => {
    const controller = new AbortController();
    let lastSnapshotRefresh = 0;
    fetchIntelligence(controller.signal).then((data) => { setSnapshot(data); setSnapshotStatus("ready"); setApiError(null); setConnection("live"); }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSnapshotStatus("error");
      setApiError(error instanceof Error ? error.message : "The dashboard could not load its intelligence snapshot.");
      setConnection("offline");
    });
    fetchRecentTransactions(80, controller.signal).then(setTransactions).catch(() => {});
    fetchOperatorProfile(controller.signal).then((data) => { setProfile(data); setProfileStatus("ready"); }).catch(() => {
      if (!controller.signal.aborted) setProfileStatus("error");
    });
    fetch("/api/auth/session", { signal: controller.signal, cache: "no-store" }).then((response) => response.json()).then((session: { username?: string }) => {
      if (session.username) setSignedInUser(session.username);
    }).catch(() => {});
    fetch(apiUrl("/api/integrations/obp/status"), { signal: controller.signal, cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((status: ProviderStatus | null) => { if (status) setProviderStatus(status); }).catch(() => {});
    const stream = new EventSource(apiUrl("/api/stream/intelligence?include_widgets=false"));
    stream.addEventListener("connected", () => setConnection("live"));
    stream.addEventListener("transaction", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as Transaction;
        setTransactions((items) => [next, ...items.filter((item) => item.transaction_id !== next.transaction_id)].slice(0, 120));
        window.dispatchEvent(new CustomEvent("fin-sentinels:transaction"));
        if (Date.now() - lastSnapshotRefresh > 10000) {
          lastSnapshotRefresh = Date.now();
          fetchIntelligence().then((data) => { setSnapshot(data); setSnapshotStatus("ready"); setApiError(null); }).catch((error: unknown) => {
            setSnapshotStatus("error");
            setApiError(error instanceof Error ? error.message : "The dashboard could not refresh its intelligence snapshot.");
            setConnection("offline");
          });
        }
      } catch (error) { console.error("Invalid transaction stream event", error); }
    });
    stream.onerror = () => setConnection("offline");
    return () => { controller.abort(); stream.close(); };
  }, []);

  useEffect(() => {
    if (!profileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileOpen(false);
    };
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsideClick);
    };
  }, [profileOpen]);

  const investigate = useCallback(async (account: string) => {
    const normalized = account.trim().toUpperCase();
    if (!normalized) return;
    if (normalized !== selectedAccount || view !== "networks") rememberWorkspace();
    const requestId = ++analysisRequest.current;
    setSelectedAccount(normalized);
    setAnalysis(null);
    setView("networks");
    try {
      const response = await fetch(apiUrl(`/api/score/${encodeURIComponent(normalized)}`), { cache: "no-store" });
      if (!response.ok) throw new Error(`Account analysis unavailable (${response.status})`);
      const nextAnalysis = await response.json() as AccountAnalysis;
      if (requestId !== analysisRequest.current) return;
      setAnalysis(nextAnalysis);
      setConnection("live");
    } catch (error) {
      if (requestId !== analysisRequest.current) return;
      setAnalysis(null);
      setConnection("offline");
    }
  }, [selectedAccount, view, rememberWorkspace]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/analyst-login");
  }, []);

  const syncBankSource = useCallback(async () => {
    setSourceSync("syncing");
    try {
      const response = await fetch(apiUrl("/api/integrations/obp/sync"), { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("Source sync failed");
      await response.json();
      const [nextTransactions, nextSnapshot] = await Promise.all([fetchRecentTransactions(120), fetchIntelligence()]);
      setTransactions(nextTransactions);
      setSnapshot(nextSnapshot);
      setSourceSync("done");
    } catch {
      setSourceSync("error");
    }
  }, []);

  const retryConnection = useCallback(async () => {
    setSnapshotStatus("loading");
    setApiError(null);
    setConnection("connecting");
    try {
      const [nextSnapshot, nextTransactions] = await Promise.all([
        fetchIntelligence(),
        fetchRecentTransactions(80),
      ]);
      setSnapshot(nextSnapshot);
      setTransactions(nextTransactions);
      setSnapshotStatus("ready");
      setConnection("live");
      try {
        const nextProfile = await fetchOperatorProfile();
        setProfile(nextProfile);
        setProfileStatus("ready");
      } catch {
        setProfileStatus("error");
      }
    } catch (error) {
      setSnapshotStatus("error");
      setApiError(error instanceof Error ? error.message : "The dashboard could not connect to its API.");
      setConnection("offline");
    }
  }, []);

  const tickerRows = useMemo(() => transactions.slice(0, 8), [transactions]);
  const workspaceTransactions = view === "networks"
    ? transactions.filter((transaction) => transaction.source_account === selectedAccount || transaction.target_account === selectedAccount)
    : transactions;
  const flagged = (snapshot?.network_status || "—").toUpperCase();
  const riskTone = flagged.includes("HIGH") || flagged.includes("FRAUD") ? "text-red-400" : flagged === "WATCH" ? "text-amber-200" : "text-emerald-200";
  const apiConnection = snapshotStatus === "error" ? "offline" : connection;
  const sidebarCompact = compact || narrowViewport;

  return <div className="terminal-grid flex h-dvh min-h-[620px] overflow-hidden text-slate-200">
    <aside className={`terminal-sidebar relative z-20 flex shrink-0 flex-col border-r border-white/[.07] bg-[#090d14]/85 backdrop-blur-xl transition-[width] duration-200 ${sidebarCompact ? "w-[64px]" : "w-[226px]"}`}>
      <div className={`flex h-[58px] items-center gap-2.5 border-b border-white/[.07] ${sidebarCompact ? "justify-center px-2" : "px-4"}`}><div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-cyan-200/20 bg-cyan-200/[.08] text-cyan-100 shadow-[0_0_22px_rgba(117,230,220,.12)]"><Shield size={17}/></div>{!sidebarCompact && <div className="min-w-0"><div className="text-[11px] font-extrabold tracking-[.16em] text-slate-100">FIN SENTINELS</div><div className="mt-0.5 text-[8px] font-semibold tracking-[.2em] text-cyan-100/45">NETWORK INTELLIGENCE</div></div>}</div>
      <div className={`pt-3 ${sidebarCompact ? "px-2" : "px-3"}`}>
        {!sidebarCompact && <div className="mb-2 px-2 text-[8px] font-bold tracking-[.19em] text-slate-600">WORKSPACES</div>}
        <a href="/terminal" title="Analyst workspace" aria-current="page" className={`mb-1 flex h-9 items-center gap-3 rounded-md border border-cyan-200/10 bg-cyan-200/[.08] ${sidebarCompact ? "justify-center px-0" : "px-2.5"} text-cyan-100`}><ShieldCheck size={15}/>{!sidebarCompact && <span className="text-[11px] font-medium">Analyst workspace</span>}</a>
        <a href="/login" title="Customer workspace sign in" className={`flex h-9 items-center gap-3 rounded-md border border-transparent text-slate-500 transition hover:bg-white/[.035] hover:text-slate-200 ${sidebarCompact ? "justify-center px-0" : "px-2.5"}`}><Users size={15}/>{!sidebarCompact && <span className="text-[11px] font-medium">Customer workspace</span>}</a>
      </div>
      <div className={`pt-5 ${sidebarCompact ? "px-2" : "px-3"}`}>{!sidebarCompact && <div className="mb-2 px-2 text-[8px] font-bold tracking-[.19em] text-slate-600">COMMAND</div>}{navigation.map((item) => <button key={item.key} onClick={() => navigateToView(item.key)} title={sidebarCompact ? item.label : undefined} aria-label={item.label} className={`group mb-1 flex h-9 w-full items-center gap-3 rounded-md ${sidebarCompact ? "justify-center px-0" : "px-2.5 text-left"} transition ${view === item.key ? "border border-cyan-200/10 bg-cyan-200/[.08] text-cyan-100" : "border border-transparent text-slate-500 hover:bg-white/[.035] hover:text-slate-200"}`}><item.icon size={15} className={view === item.key ? "text-cyan-200" : "text-slate-600 group-hover:text-slate-300"}/>{!sidebarCompact && <span className="flex-1 text-[11px] font-medium">{item.label}</span>}</button>)}</div>
      <div className={`${sidebarCompact ? "mx-2" : "mx-3"} mt-5 border-t border-white/[.06] pt-4`}>{!sidebarCompact && <div className="mb-2 px-2 text-[8px] font-bold tracking-[.19em] text-slate-600">INTELLIGENCE SOURCES</div>}{[{ icon: Database, name: "Bank source", state: providerStatus?.configured === true || providerStatus?.historical_sync_ready === true || providerStatus?.webhook_ready === true }, { icon: Globe2, name: "Geo velocity", state: Boolean(snapshot?.observed_countries?.length) }, { icon: FingerprintIcon, name: "Device graph", state: Boolean(snapshot?.shared_device_count) }].map(({ icon: Icon, name, state }) => <div key={name} title={sidebarCompact ? name : undefined} className={`flex h-8 items-center ${sidebarCompact ? "justify-center" : "gap-2.5 px-2.5"}`}><Icon size={13} className="text-slate-600"/>{!sidebarCompact && <><span className="flex-1 text-[10px] text-slate-500">{name}</span><i className={`h-1.5 w-1.5 rounded-full ${state ? "bg-emerald-300" : "bg-slate-700"}`} title={name === "Bank source" ? (state ? "Bank connector is configured" : "No bank provider is configured") : undefined}/></>}</div>)}</div>
      <div className="mt-auto p-3"><div className={`rounded-lg border border-white/[.07] bg-white/[.025] ${sidebarCompact ? "p-2" : "p-3"}`}><div className={`flex items-center ${sidebarCompact ? "justify-center" : "gap-2"}`}><div className={`h-1.5 w-1.5 rounded-full ${apiConnection === "live" ? "signal-pulse bg-emerald-300" : apiConnection === "connecting" ? "bg-amber-300" : "bg-rose-300"}`}/>{!sidebarCompact && <span className="text-[9px] font-semibold tracking-[.12em] text-slate-400">{apiConnection === "live" ? "API CONNECTED" : apiConnection === "connecting" ? "LOADING DATA" : "API OFFLINE"}</span>}</div>{!sidebarCompact && <div className="mt-2 font-mono text-[9px] text-slate-600">{snapshot?.data_mode === "demo" ? "LOCAL · SYNTHETIC DATA" : snapshot?.data_mode === "production" ? "PRODUCTION DATA MODE" : "FIN SENTINELS WORKSPACE"}</div>}</div><button type="button" onClick={toggleCompactSidebar} disabled={narrowViewport} title={narrowViewport ? "Sidebar is compact on smaller screens" : sidebarCompact ? "Expand sidebar" : "Collapse sidebar"} aria-label={narrowViewport ? "Sidebar is compact on smaller screens" : sidebarCompact ? "Expand sidebar" : "Collapse sidebar"} className="mt-3 flex h-8 w-full items-center justify-center rounded text-slate-600 hover:bg-white/[.04] hover:text-slate-300 disabled:cursor-default disabled:opacity-50"><Menu size={14}/></button></div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col">
      <header className="relative z-40 shrink-0 border-b border-white/[.07] bg-[#0a0e16]/85 backdrop-blur-xl">
        <div className="flex h-[58px] items-center gap-4 px-5"><div className="min-w-0 flex-1 sm:min-w-[150px] sm:flex-none"><div className="text-[13px] font-extrabold tracking-[.12em] text-slate-100">FIN SENTINELS</div><div className="mt-0.5 truncate text-[9px] text-slate-600">{view === "overview" ? "NATIONAL INTELLIGENCE" : view === "networks" ? "ACCOUNT INVESTIGATION" : view === "agents" ? "SIGNAL REVIEW" : "CASE OPERATIONS"} · ANALYST WORKSPACE</div></div>
          <div className="mx-auto hidden min-w-0 flex-1 items-center md:flex" />
          <WorkspaceSwitcher active="analyst" />
          <div className="hidden shrink-0 items-center gap-1.5 rounded-md border border-emerald-300/10 bg-emerald-300/[.035] px-2 py-1.5 sm:flex"><i className={`h-1.5 w-1.5 rounded-full ${apiConnection === "live" ? "signal-pulse bg-emerald-300" : apiConnection === "connecting" ? "bg-amber-300" : "bg-rose-400"}`}/><span className={`text-[8px] font-bold tracking-[.1em] ${apiConnection === "live" ? "text-emerald-200" : apiConnection === "connecting" ? "text-amber-200" : "text-rose-300"}`}>{apiConnection === "live" ? "API CONNECTED" : apiConnection === "connecting" ? "LOADING DATA" : "API OFFLINE"}</span></div>
          <div title={providerStatus?.configured || providerStatus?.historical_sync_ready ? "Bank connector is configured. Live activity still depends on account consent and provider delivery." : providerStatus?.webhook_ready ? "Signed bank-event intake is configured; historical polling still needs an authorized provider connection." : "No bank provider is connected. The graph currently uses the workspace dataset."} className={`hidden shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 xl:flex ${(providerStatus?.configured || providerStatus?.historical_sync_ready || providerStatus?.webhook_ready) ? "border-cyan-300/15 bg-cyan-300/[.035] text-cyan-100/75" : "border-amber-300/10 bg-amber-300/[.025] text-amber-100/60"}`}><i className={`h-1.5 w-1.5 rounded-full ${(providerStatus?.configured || providerStatus?.historical_sync_ready || providerStatus?.webhook_ready) ? "bg-cyan-200" : "bg-amber-300"}`}/><span className="text-[8px] font-bold tracking-[.1em]">{providerStatus?.configured || providerStatus?.historical_sync_ready ? "BANK SOURCE READY" : providerStatus?.webhook_ready ? "SIGNED EVENT INTAKE" : "BANK SOURCE NOT CONNECTED"}</span></div>
          {providerStatus?.historical_sync_ready && <button type="button" disabled={sourceSync === "syncing"} onClick={syncBankSource} title={sourceSync === "done" ? "Ledger synchronization complete" : sourceSync === "error" ? "Sync unavailable; check the bank connection" : "Poll authorized bank accounts for historical ledger entries"} className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[.08] px-2 text-[8px] font-bold tracking-[.09em] text-slate-400 transition hover:border-cyan-200/20 hover:text-cyan-100 disabled:opacity-50 xl:flex">{sourceSync === "syncing" ? "SYNCING…" : sourceSync === "done" ? "SYNCED" : sourceSync === "error" ? "RETRY SYNC" : "SYNC LEDGER"}</button>}
          <Button variant="outline" onClick={() => setPaletteOpen(true)} className="h-8 shrink-0 px-2.5 text-[10px]"><Search size={12}/><span className="hidden sm:inline">Search / command</span><kbd className="ml-1 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">⌘ K</kbd></Button>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={undoWorkspace} disabled={!canUndo} title={canUndo ? "Undo last workspace action · Ctrl+Z" : "No workspace actions to undo"} aria-label="Undo last workspace action" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[.08] px-2 text-[9px] font-semibold text-slate-300 transition hover:border-cyan-200/20 hover:text-cyan-100 disabled:cursor-default disabled:opacity-40"><Undo2 size={12}/><span className="hidden xl:inline">UNDO</span></button>
            <button type="button" onClick={resetWorkspace} title="Reset workspace to the default overview" aria-label="Reset workspace" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[.08] px-2 text-[9px] font-semibold text-slate-400 transition hover:border-cyan-200/20 hover:text-cyan-100"><RotateCcw size={12}/><span className="hidden xl:inline">RESET</span></button>
          </div>
          <div ref={profileRef} className="relative flex shrink-0 items-center gap-3 border-l border-white/[.08] pl-3 sm:pl-4">
            <WorkspaceClock />
            <button type="button" aria-label="Open operator profile" aria-expanded={profileOpen} onClick={() => setProfileOpen((open) => !open)} className="grid h-8 w-8 place-items-center rounded-full border border-cyan-200/20 bg-cyan-200/[.07] font-mono text-[9px] font-bold text-cyan-100 shadow-[0_0_18px_rgba(117,230,220,.08)] transition hover:border-cyan-200/40 hover:bg-cyan-200/[.12]">{profileInitials}</button>
            {profileOpen && <div className="glass-panel absolute right-0 top-11 z-50 w-[min(16rem,calc(100vw-2rem))] rounded-xl p-3 shadow-2xl shadow-black/50">
              <div className="flex items-center gap-3 border-b border-white/[.07] pb-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-cyan-200/20 bg-cyan-200/[.08] font-mono text-[11px] font-bold text-cyan-100">{profileInitials}</div><div className="min-w-0"><div className="truncate text-[10px] font-bold tracking-[.08em] text-slate-200">{signedInUser || profile?.name || "Loading profile…"}</div><div className="mt-1 truncate text-[8px] tracking-wider text-slate-500">{signedInUser ? "ANALYST" : profile?.role || "OPERATOR PROFILE"}</div></div></div>
              <div className="mt-3 space-y-2"><ProfileField label="ORGANIZATION" value={profile?.organization || "FinSentinels"}/><ProfileField label="ACTIVE CASES" value={profile ? `${profile.active_cases} / ${profile.total_cases}` : "LOADING"}/><ProfileField label="SYSTEM" value={profile?.system || "LOADING"} tone={profile?.system?.toUpperCase() === "ONLINE" ? "text-emerald-300" : "text-amber-200"}/></div>
              <div className="mt-3 border-t border-white/[.06] pt-2 text-[8px] leading-relaxed text-slate-600">Profile information is loaded from the Fin Sentinels API.</div>
              <button type="button" onClick={signOut} className="mt-3 flex h-8 w-full items-center gap-2 rounded-md border border-white/[.08] px-2.5 text-left text-[9px] text-slate-400 transition hover:border-rose-300/20 hover:bg-rose-300/[.04] hover:text-rose-200"><LogOut size={12}/> SIGN OUT</button>
            </div>}
          </div>
        </div>
        <div className="flex min-h-10 flex-wrap items-center gap-2 overflow-hidden border-t border-white/[.04] bg-black/15 px-3 sm:px-5"><span className="hidden shrink-0 text-[8px] font-bold tracking-[.18em] text-cyan-100/55 sm:inline"><Radio size={10} className="mr-1 inline"/>FLOW TAPE</span><div className="min-w-[100px] flex-1"><TickerTape rows={tickerRows} onAnalyze={investigate}/></div><span className="hidden shrink-0 items-center gap-1 text-[8px] text-slate-600 xl:flex"><Wifi size={10}/>EVENT STREAM · SELECT AN ACCOUNT TO INVESTIGATE</span></div>
      </header>

      <div className="terminal-scroll min-h-0 flex-1 overflow-auto p-4 lg:p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><div className="flex items-center gap-2 text-[9px] font-bold tracking-[.19em] text-cyan-100/55"><span className="h-px w-5 bg-cyan-200/60"/>{view === "overview" ? "NATIONAL FRAUD INTELLIGENCE" : view === "networks" ? "RELATIONSHIP INVESTIGATION" : view === "agents" ? "MODEL EVIDENCE REVIEW" : "INVESTIGATION OPERATIONS"}</div><h1 className="mt-1.5 text-[18px] font-semibold tracking-tight text-slate-100">{view === "overview" ? "National network overview" : view === "networks" ? `Account investigation · ${selectedAccount}` : view === "agents" ? "Explainable signal review" : "Case operations"}</h1><p className="mt-1 text-[11px] text-slate-500">{view === "overview" ? "Live operations desk for network risk, priority accounts, and recent transfer activity." : view === "networks" ? "Trace observed transfers and shared infrastructure around the selected account." : view === "agents" ? "Review graph, network, and behavior evidence for every account. Signals support analyst review; they do not make decisions." : "Review case status, attached evidence, and analyst follow-up."}</p></div><div className="flex items-center gap-2">{snapshot && <span title={snapshot.source_mode || "Transaction source mode"} className={`hidden rounded border px-2 py-1.5 font-mono text-[9px] sm:inline ${snapshot.data_mode === "demo" ? "border-amber-300/15 bg-amber-300/[.04] text-amber-100/75" : "border-cyan-300/15 bg-cyan-300/[.04] text-cyan-100/75"}`}>{snapshot.data_mode === "demo" ? "DEMO DATA" : snapshot.account_count === 0 ? "AWAITING DATA" : "PRODUCTION DATA"}</span>}<span className="hidden rounded border border-white/[.08] bg-white/[.025] px-2 py-1.5 font-mono text-[9px] text-slate-500 sm:inline">LATEST TRANSACTION {snapshot?.last_transaction_at?.slice(0, 10) || (snapshot?.data_mode === "production" ? "NO RECORDS" : "WAITING FOR API")}</span>{view === "networks" && networkRiskHidden && <button type="button" onClick={() => hideRiskMonitor(false)} className="flex h-8 items-center gap-1.5 rounded-md border border-cyan-200/15 bg-cyan-200/[.05] px-2.5 text-[9px] font-bold tracking-wide text-cyan-100 hover:bg-cyan-200/[.1]"><Eye size={12}/>SHOW RISK MONITOR</button>}{view === "agents" && agentFeedHidden && <button type="button" onClick={() => hideAgentFeed(false)} className="flex h-8 items-center gap-1.5 rounded-md border border-cyan-200/15 bg-cyan-200/[.05] px-2.5 text-[9px] font-bold tracking-wide text-cyan-100 hover:bg-cyan-200/[.1]"><Eye size={12}/>RESTORE SIGNAL FEED</button>}<Button variant="ghost" onClick={() => setPaletteOpen(true)} className="h-7 px-2 text-[9px]"><Command size={12}/>COMMANDS</Button></div></div>

        {snapshotStatus === "loading" && !snapshot && <div role="status" aria-live="polite" className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200/15 bg-amber-200/[.035] px-3 py-2.5 text-[10px] text-amber-100/80"><span className="h-2 w-2 rounded-full bg-amber-200 signal-pulse"/>Loading the dashboard snapshot from FastAPI. A slow or unavailable response will be reported here.</div>}
        {snapshotStatus === "error" && <div role="alert" aria-live="assertive" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-rose-300/20 bg-rose-300/[.045] px-3 py-3"><AlertTriangle size={15} className="shrink-0 text-rose-300"/><div className="min-w-[220px] flex-1"><div className="text-[10px] font-bold text-rose-100">Dashboard data could not be loaded</div><p className="mt-1 break-words text-[9px] leading-relaxed text-rose-100/65">{apiError || "The API request failed. Check the local backend and retry."}</p></div><button type="button" onClick={retryConnection} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rose-200/20 bg-rose-200/[.07] px-2.5 text-[9px] font-bold tracking-wide text-rose-100 transition hover:bg-rose-200/[.12]"><RotateCcw size={11}/>RETRY CONNECTION</button></div>}

        {view === "overview" && <>
          <LivePulse transaction={transactions[0]} connection={connection} onAnalyze={investigate}/>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6"><Metric icon={ShieldCheck} label="High-risk accounts" value={snapshot?.high_risk_network_accounts} sub="REVIEW FIRST" tone="text-rose-300"/><Metric icon={Eye} label="Watch list" value={snapshot?.watch_network_accounts} sub="ELEVATED EVIDENCE" tone="text-amber-200"/><Metric icon={Activity} label="Network index" value={snapshot ? `${snapshot.network_risk_score}/100` : "—"} sub="RANKING · NOT PROBABILITY" tone={riskTone}/><Metric icon={WalletCards} label="Active cases" value={profile?.active_cases ?? (profileStatus === "loading" ? "…" : "N/A")} sub={profile ? `${profile.total_cases} TOTAL IN QUEUE` : profileStatus === "loading" ? "LOADING CASE QUEUE" : "CASE DATA UNAVAILABLE"}/><Metric icon={Network} label="Accounts monitored" value={snapshot?.account_count} sub="NATIONAL GRAPH"/><Metric icon={Database} label="Transfer records" value={snapshot?.transaction_count} sub={`${transactions.length} LOADED HERE`}/></div>
        </>}

        <AnimatePresence mode="wait">
          <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .16 }} className="space-y-3">
            {view === "cases" ? <CaseQueue onAnalyze={investigate} selectedAccount={selectedAccount}/> : view === "agents" ? agentFeedHidden ? <Panel className="grid min-h-[260px] place-items-center"><div className="max-w-md px-6 text-center"><div className="text-sm font-semibold text-slate-200">Signal feed hidden</div><p className="mt-2 text-xs leading-relaxed text-slate-500">The live graph evidence feed is paused from this workspace view. Restore it when you are ready to review incoming signals.</p><Button type="button" variant="outline" onClick={() => hideAgentFeed(false)} className="mt-4 h-9 px-3 text-xs"><Eye size={14}/> RESTORE SIGNAL FEED</Button></div></Panel> : <AgentStream account="" onInvestigate={investigate} onHide={() => hideAgentFeed(true)}/> : view === "overview" ? <OperationsDesk snapshot={snapshot} transactions={transactions} onNavigate={navigateToView} onAnalyze={investigate}/> : <>
              <div className={`terminal-main-grid grid ${networkRiskHidden ? "grid-cols-1" : "grid-cols-[minmax(0,1.65fr)_minmax(340px,.9fr)]"} items-stretch gap-4`}>
                <Panel className="h-[clamp(420px,56vh,580px)]"><NetworkGraph key={selectedAccount} scope="account" account={selectedAccount} sourceState={apiConnection} onAnalyze={investigate}/></Panel>
                {!networkRiskHidden && <NetworkRiskPanel snapshot={snapshot} analysis={analysis} account={selectedAccount} onAnalyze={investigate} onHide={() => hideRiskMonitor(true)} className="h-[clamp(420px,56vh,580px)]"/>}
              </div>
              <WorkspaceModuleTabs mode="networks" active={workspaceModule} onChange={changeWorkspaceModule}/>
              {workspaceModule === "flow" ? <Panel className="h-[clamp(340px,48vh,520px)]"><TerminalChart transactions={workspaceTransactions}/></Panel> : <TransactionLedger transactions={workspaceTransactions} onAnalyze={investigate} title="ACCOUNT TRANSFER EVIDENCE"/>}
            </>}
            <div className="flex items-center justify-between border-t border-white/[.05] pt-2 text-[8px] tracking-wider text-slate-700"><span>FIN SENTINELS · GRAPH NEURAL RISK ENGINE · EXPLAINABLE NETWORK SCORING</span><span className="font-mono">BUILD 0.9.4 · API {apiConnection.toUpperCase()}</span></div>
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNavigate={(destination) => navigateToView(destination as View)} onAnalyze={investigate}/>
  </div>;
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <Card className={`panel-glow glass-panel relative min-w-0 overflow-hidden ${className}`}>{children}<span className="pointer-events-none absolute left-0 top-0 h-px w-16 bg-gradient-to-r from-cyan-200/60 to-transparent"/><BorderBeam/></Card>;
}

function LoadingPanel({ label }: { label: string }) {
  return <div className="flex items-center gap-2.5 text-[10px] text-slate-400"><span className="h-2 w-2 rounded-full bg-cyan-200 shadow-[0_0_12px_rgba(117,230,220,.75)] signal-pulse"/>{label}</div>;
}

function LivePulse({ transaction, connection, onAnalyze }: { transaction?: Transaction; connection: "connecting" | "live" | "offline"; onAnalyze: (account: string) => void }) {
  const isLive = connection === "live";
  const amount = transaction?.amount_inr ?? transaction?.amount;
  const requestedCurrency = transaction?.amount_inr != null ? "INR" : String(transaction?.currency || "INR").toUpperCase();
  const currency = /^[A-Z]{3}$/.test(requestedCurrency) ? requestedCurrency : "INR";
  const amountLabel = typeof amount === "number" ? new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount) : "Amount unavailable";
  const provider = transaction?.source_provider?.toUpperCase() === "OBP" ? "BANK EVENT" : "WORKSPACE RECORD";

  return <section aria-label="Latest network activity" className="live-pulse mb-3 flex min-h-[74px] flex-wrap items-center gap-3 overflow-hidden rounded-lg border border-cyan-200/[.15] bg-[radial-gradient(ellipse_at_18%_50%,rgba(46,191,194,.13),transparent_48%),linear-gradient(110deg,rgba(13,23,33,.96),rgba(8,13,20,.96))] px-3.5 py-3 sm:px-4">
    <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cyan-100/20 bg-cyan-100/[.07] text-cyan-100"><Network size={17}/><span className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0c131b] ${isLive ? "bg-emerald-300 signal-pulse" : connection === "connecting" ? "bg-amber-300" : "bg-rose-300"}`}/></div>
    <div className="min-w-[190px] flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[9px] font-bold tracking-[.16em] text-cyan-100/80">NETWORK ACTIVITY PULSE</span><span className={`rounded border px-1.5 py-0.5 font-mono text-[7px] tracking-wider ${isLive ? "border-emerald-300/15 bg-emerald-300/[.04] text-emerald-200" : connection === "connecting" ? "border-amber-300/15 bg-amber-300/[.04] text-amber-200" : "border-rose-300/15 bg-rose-300/[.04] text-rose-200"}`}>{isLive ? "STREAM LIVE" : connection === "connecting" ? "LOADING ACTIVITY" : "STREAM OFFLINE"}</span></div>
      {transaction ? <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-200"><span className="font-mono text-cyan-100">{transaction.source_account}</span><ArrowUpRight size={12} className="text-cyan-200/60"/><span className="font-mono text-cyan-100">{transaction.target_account}</span><span className="text-slate-600">·</span><span>{amountLabel}</span><span className="text-[8px] tracking-wider text-slate-500">{provider}</span></div> : <p className="mt-1.5 text-[10px] text-slate-500">{isLive ? "Waiting for the next transaction event." : "Reconnect to the intelligence stream to show new activity."}</p>}
    </div>
    {transaction && <button type="button" onClick={() => onAnalyze(transaction.source_account)} className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-cyan-200/20 bg-cyan-200/[.07] px-2.5 text-[9px] font-semibold text-cyan-100 transition hover:border-cyan-200/40 hover:bg-cyan-200/[.12]">TRACE ROUTE<ArrowUpRight size={12}/></button>}
  </section>;
}

function WorkspaceClock() {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return <div className="hidden text-right sm:block"><div className="font-mono text-[10px] text-slate-300">{clock || "--:--:--"}</div><div className="mt-0.5 text-[8px] tracking-wider text-slate-600">IST · MUMBAI</div></div>;
}

function Metric({ icon: Icon, label, value, sub, tone = "text-slate-100" }: { icon: typeof Activity; label: string; value?: string | number; sub: string; tone?: string }) {
  return <div className="panel-glow glass-panel rounded-lg px-3 py-2.5"><div className="flex items-center justify-between"><span className="text-[9px] text-slate-400">{label}</span><Icon size={13} className="text-slate-600"/></div><div className={`mono-metric mt-2 font-mono text-[18px] font-semibold ${tone}`}>{value == null ? "—" : typeof value === "number" ? value.toLocaleString("en-IN") : value}</div><div className="mt-1 text-[8px] font-semibold tracking-[.12em] text-slate-500">{sub}</div></div>;
}

function OperationsDesk({ snapshot, transactions, onNavigate, onAnalyze }: { snapshot: IntelligenceSnapshot | null; transactions: Transaction[]; onNavigate: (view: View) => void; onAnalyze: (account: string) => void }) {
  const high = snapshot?.high_risk_network_accounts ?? 0;
  const watch = snapshot?.watch_network_accounts ?? 0;
  const total = Math.max(snapshot?.account_count ?? 0, high + watch);
  const lower = Math.max(0, total - high - watch);
  const share = (count: number) => total ? `${(count / total) * 100}%` : "0%";
  const priorityAccounts = snapshot?.priority_accounts?.slice(0, 6) ?? [];

  return <section aria-label="Fraud operations desk" className="space-y-3">
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,.85fr)]">
      <Panel className="min-h-[310px]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] px-4 py-3">
          <div className="flex items-center gap-2.5"><div className="grid h-8 w-8 place-items-center rounded-lg border border-rose-300/15 bg-rose-300/[.06] text-rose-200"><ShieldCheck size={15}/></div><div><div className="text-[10px] font-bold tracking-[.14em] text-slate-200">PRIORITY ACCOUNT REVIEW</div><div className="mt-1 text-[9px] text-slate-500">Highest network evidence scores · analyst review required</div></div></div>
          <button type="button" onClick={() => onNavigate("agents")} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[.08] px-2.5 text-[9px] font-semibold text-slate-400 transition hover:border-cyan-200/20 hover:text-cyan-100">ALL SIGNALS<ArrowUpRight size={12}/></button>
        </div>
        <div className="divide-y divide-white/[.045] px-3">
          {priorityAccounts.length ? priorityAccounts.map((item, index) => {
            const status = item.status.toUpperCase();
            const tone = status.includes("HIGH") ? "text-rose-300 border-rose-300/15 bg-rose-300/[.05]" : status === "WATCH" ? "text-amber-200 border-amber-300/15 bg-amber-300/[.05]" : "text-emerald-200 border-emerald-300/15 bg-emerald-300/[.04]";
            const bar = status.includes("HIGH") ? "from-rose-400 to-rose-300" : status === "WATCH" ? "from-amber-400 to-yellow-200" : "from-emerald-400 to-cyan-200";
            return <div key={item.account_id} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 py-3">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-white/[.035] font-mono text-[9px] text-slate-500">{String(index + 1).padStart(2, "0")}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => onAnalyze(item.account_id)} className="font-mono text-[10px] font-bold text-cyan-100/90 transition hover:text-white">{item.account_id}</button><span className={`rounded border px-1.5 py-0.5 text-[7px] font-bold tracking-wider ${tone}`}>{status}</span>{item.cycle_count ? <span className="text-[7px] tracking-wide text-rose-200/70">{item.cycle_count} CIRCULAR FLOW{item.cycle_count === 1 ? "" : "S"}</span> : null}</div>
                <div className="mt-1.5 truncate text-[9px] text-slate-500" title={item.reasons?.join(" · ")}>{item.reasons?.[0] || "Review linked account and transfer evidence"}</div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[.06]"><div className={`h-full rounded-full bg-gradient-to-r ${bar}`} style={{ width: `${Math.max(3, Math.min(100, item.risk_score))}%` }}/></div>
              </div>
              <button type="button" onClick={() => onAnalyze(item.account_id)} aria-label={`Investigate ${item.account_id}`} className="inline-flex h-8 items-center gap-1 rounded-md border border-cyan-200/15 bg-cyan-200/[.035] px-2 text-[8px] font-semibold text-cyan-100/85 transition hover:border-cyan-200/35 hover:bg-cyan-200/[.08]">{item.risk_score}<span className="text-cyan-100/45">/100</span><ArrowUpRight size={11}/></button>
            </div>;
          }) : <div className="grid min-h-[210px] place-items-center px-4 text-center">
            <div><div className="text-[11px] font-semibold text-slate-300">{snapshot ? "No account evidence to rank yet" : "Building the review list"}</div><p className="mx-auto mt-1.5 max-w-sm text-[9px] leading-relaxed text-slate-500">{snapshot ? "Connect an authorized source or ingest a transaction set to populate account-level network evidence." : "The desk is loading the national snapshot. This page stays lightweight while the interactive network map is available on demand."}</p></div>
          </div>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[.06] px-4 py-2.5"><span className="text-[8px] text-slate-600">Scores are evidence rankings, not fraud probabilities or automated decisions.</span><button type="button" onClick={() => onNavigate("networks")} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-cyan-200 px-2.5 text-[8px] font-bold tracking-wide text-[#071117] transition hover:bg-cyan-100">OPEN NETWORK MAP<ArrowUpRight size={11}/></button></div>
      </Panel>

      <Panel className="min-h-[310px]">
        <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-3"><div className="flex items-center gap-2"><Network size={14} className="text-cyan-200"/><span className="text-[10px] font-bold tracking-[.14em] text-slate-200">NETWORK POSTURE</span></div><span className="rounded border border-white/[.07] bg-white/[.025] px-1.5 py-1 font-mono text-[7px] text-slate-500">NATIONAL</span></div>
        <div className="p-4">
          <div className="flex items-end justify-between gap-3"><div><div className="text-[8px] font-bold tracking-[.14em] text-slate-600">NETWORK RISK INDEX</div><div className="mt-1 font-mono text-4xl font-semibold tracking-tight text-amber-200">{snapshot ? snapshot.network_risk_score : "—"}<span className="ml-1 text-sm text-slate-600">/100</span></div></div><div className="max-w-[150px] text-right text-[8px] leading-relaxed text-slate-500">Mean account-context score. Ranking index, not calibrated fraud probability.</div></div>
          <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-white/[.05]" aria-label={`Risk distribution: ${high} high risk, ${watch} watch, ${lower} lower rank`}><div className="h-full bg-rose-400" style={{ width: share(high) }}/><div className="h-full bg-amber-300" style={{ width: share(watch) }}/><div className="h-full bg-emerald-300/60" style={{ width: share(lower) }}/></div>
          <div className="mt-2.5 grid grid-cols-3 gap-2">{[{ label: "HIGH RISK", count: high, color: "bg-rose-300" }, { label: "WATCH", count: watch, color: "bg-amber-200" }, { label: "LOWER RANK", count: lower, color: "bg-emerald-200" }].map((item) => <div key={item.label} className="rounded-md border border-white/[.055] bg-black/10 px-2 py-2"><div className="flex items-center gap-1.5 text-[7px] font-bold tracking-wider text-slate-500"><i className={`h-1.5 w-1.5 rounded-full ${item.color}`}/>{item.label}</div><div className="mt-1.5 font-mono text-[16px] text-slate-200">{snapshot ? item.count.toLocaleString("en-IN") : "—"}</div></div>)}</div>
          <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-md border border-white/[.055] bg-black/10 px-2.5 py-2"><div className="text-[7px] font-bold tracking-wider text-slate-600">SHARED DEVICE / IP LINKS</div><div className="mt-1 font-mono text-[11px] text-slate-300">{snapshot ? `${snapshot.shared_device_count} / ${snapshot.shared_ip_count}` : "—"}</div></div><div className="rounded-md border border-white/[.055] bg-black/10 px-2.5 py-2"><div className="text-[7px] font-bold tracking-wider text-slate-600">COUNTRIES OBSERVED</div><div className="mt-1 truncate font-mono text-[11px] text-slate-300" title={snapshot?.observed_countries.join(", ")}>{snapshot?.observed_countries.slice(0, 3).join(", ") || (snapshot ? "No country data" : "—")}</div></div></div>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => onNavigate("cases")} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-white/[.08] px-2 text-[8px] font-semibold tracking-wide text-slate-300 transition hover:border-cyan-200/20 hover:text-cyan-100"><WalletCards size={12}/>CASE QUEUE<ArrowUpRight size={10}/></button><button type="button" onClick={() => onNavigate("agents")} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-white/[.08] px-2 text-[8px] font-semibold tracking-wide text-slate-300 transition hover:border-cyan-200/20 hover:text-cyan-100"><Sparkles size={12}/>EXPLAIN SIGNALS<ArrowUpRight size={10}/></button></div>
        </div>
      </Panel>
    </div>

    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.06] px-4 py-3"><div className="flex items-center gap-2"><Activity size={14} className="text-cyan-200"/><span className="text-[10px] font-bold tracking-[.14em] text-slate-200">RECENT TRANSFER ACTIVITY</span><span className="rounded border border-white/[.07] px-1.5 py-0.5 font-mono text-[7px] text-slate-500">{transactions.length} LOADED</span></div><button type="button" onClick={() => onNavigate("networks")} className="text-[8px] font-semibold tracking-wide text-cyan-100/65 transition hover:text-cyan-100">OPEN INVESTIGATION VIEW<ArrowUpRight size={10} className="ml-1 inline"/></button></div>
      {transactions.length ? <div className="divide-y divide-white/[.04]">{transactions.slice(0, 5).map((transaction) => <div key={transaction.transaction_id} className="grid grid-cols-[58px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5">
        <div className="font-mono text-[8px] text-slate-500">{Number.isNaN(Date.parse(transaction.timestamp)) ? "—" : new Date(transaction.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</div>
        <div className="min-w-0"><div className="flex min-w-0 items-center gap-1.5 text-[9px]"><button type="button" onClick={() => onAnalyze(transaction.source_account)} className="truncate font-mono text-cyan-100/80 hover:text-cyan-100">{transaction.source_account}</button><ArrowUpRight size={10} className="shrink-0 text-slate-600"/><button type="button" onClick={() => onAnalyze(transaction.target_account)} className="truncate font-mono text-slate-300 hover:text-white">{transaction.target_account}</button></div><div className="mt-1 truncate text-[8px] text-slate-600">{[transaction.location_country || transaction.location, transaction.device_id ? "DEVICE LINK" : null, transaction.ip_address ? "IP OBSERVED" : null, transaction.source_provider === "OBP" ? "BANK EVENT" : null].filter(Boolean).join(" · ") || "Transfer observed · no additional context attached"}</div></div>
        <div className="text-right font-mono text-[9px] text-slate-300">{formatCurrency(transaction.amount, transaction.currency || "INR")}</div>
      </div>)}</div> : <div className="grid min-h-[92px] place-items-center px-4 text-center text-[9px] text-slate-500">{snapshot ? "Waiting for transaction activity from the connected source." : "Loading transaction activity…"}</div>}
    </Panel>
  </section>;
}

function WorkspaceModuleTabs({ mode, active, onChange }: { mode: "overview" | "networks"; active: WorkspaceModule; onChange: (module: WorkspaceModule) => void }) {
  const options: { key: WorkspaceModule; label: string; icon: typeof Activity; detail: string }[] = mode === "networks" ? [
    { key: "transactions", label: "Account transfers", icon: Layers3, detail: "Observed records touching the focused account" },
    { key: "flow", label: "Account flow", icon: Activity, detail: "Transfer value touching the focused account" },
  ] : [
    { key: "transactions", label: "Transaction activity", icon: Layers3, detail: "Recent national graph records" },
    { key: "flow", label: "Flow analysis", icon: Activity, detail: "National transfer value over time" },
  ];
  return <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/[.07] pb-2">
    <div><div className="text-[8px] font-bold tracking-[.18em] text-slate-600">INVESTIGATION WORKSPACE</div><div className="mt-1 text-[11px] font-medium text-slate-300">{options.find((option) => option.key === active)?.detail}</div></div>
    <div role="tablist" aria-label="Investigation workspace" className="flex flex-wrap items-center gap-1 rounded-lg border border-white/[.06] bg-black/15 p-1">
      {options.map(({ key, label, icon: Icon }) => <button key={key} type="button" role="tab" aria-selected={active === key} onClick={() => onChange(key)} className={`flex h-8 items-center gap-2 rounded-md px-2.5 text-[9px] font-medium transition sm:px-3 ${active === key ? "bg-cyan-200/[.09] text-cyan-100 shadow-[inset_0_0_0_1px_rgba(103,232,249,.12)]" : "text-slate-500 hover:bg-white/[.04] hover:text-slate-200"}`}><Icon size={12}/>{label}</button>)}
    </div>
  </div>;
}

function ProfileField({ label, value, tone = "text-slate-300" }: { label: string; value: string; tone?: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-[8px] font-semibold tracking-wider text-slate-600">{label}</span><span className={`truncate text-right font-mono text-[8px] ${tone}`}>{value}</span></div>;
}

function getInitials(name: string) {
  return name.replace(/\./g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "RK";
}

function NetworkRiskPanel({ snapshot, analysis, account, onAnalyze, onHide, className = "h-[310px]" }: { snapshot: IntelligenceSnapshot | null; analysis: AccountAnalysis | null; account: string; onAnalyze: (account: string) => void; onHide: () => void; className?: string }) {
  const [input, setInput] = useState(account);
  useEffect(() => setInput(account), [account]);
  const score = analysis?.risk_score ?? snapshot?.network_risk_score ?? 0;
  const band = analysis?.status ?? snapshot?.network_status ?? "UNKNOWN";
  const level = band.toUpperCase();
  const tone = level.includes("HIGH") || level.includes("FRAUD") ? "#EF4444" : level === "WATCH" ? "#f6bd68" : "#a1edbd";
  const routes = analysis ? analysis.network?.observed_routes || [] : snapshot?.observed_routes || [];
  const countries = analysis ? analysis.network?.observed_countries || [] : snapshot?.observed_countries || [];
  const locations = analysis ? analysis.network?.observed_locations || [] : [];
  const geography = routes.length
    ? routes.slice(0, 2).join(" · ")
    : countries.length
      ? countries.join(" · ")
      : locations.length
        ? locations.slice(0, 2).join(" · ")
        : "No country metadata in source";
  const geographyLabel = routes.length ? "CROSS-BORDER ROUTES" : countries.length ? "COUNTRIES OBSERVED" : locations.length ? "OBSERVED LOCATIONS" : "GEO CONTEXT";

  return <Panel className={className}>
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-2.5">
        <div className="flex items-center gap-2"><ShieldCheck size={14} className="text-cyan-200"/><span className="text-[10px] font-bold tracking-[.14em] text-slate-300">NETWORK RISK MONITOR</span></div>
        <div className="flex items-center gap-2"><span className="rounded border border-white/[.07] px-1.5 py-1 font-mono text-[8px] text-slate-600">IN-WEST</span><button type="button" onClick={onHide} aria-label="Hide network risk monitor" title="Hide panel; restore it from the page toolbar" className="grid h-7 w-7 place-items-center rounded-md border border-white/[.07] text-slate-500 transition hover:border-cyan-200/20 hover:text-cyan-100"><Eye size={12}/></button></div>
      </div>
      <div className="flex flex-1 flex-col px-4 py-3">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[9px] text-slate-600">{analysis ? `FOCUSED ACCOUNT NETWORK · ${analysis.account_id}` : "NATIONAL NETWORK INDEX · MEAN OF COHORTS"}</div>
            <div className="mt-1 flex items-baseline gap-2"><strong className="font-mono text-[36px] font-semibold leading-none tracking-tight" style={{ color: tone }}>{score}<small className="text-[14px] text-slate-600">/100</small></strong><span className="text-[10px] font-bold tracking-[.1em]" style={{ color: tone }}>{level}</span></div>
          </div>
          <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/[.07] bg-white/[.025]" style={{ color: tone }}>{level.includes("HIGH") || level.includes("FRAUD") ? <AlertTriangle size={16}/> : <ShieldCheck size={16}/>}</div>
        </div>
        <div className="mt-3 h-1 overflow-hidden rounded bg-white/[.07]"><div className="h-full rounded transition-all" style={{ width: `${Math.min(100, score)}%`, background: `linear-gradient(90deg,#75e6dc,${tone})`, boxShadow: `0 0 12px ${tone}55` }}/></div>
        <p className="mt-3 line-clamp-2 min-h-[30px] text-[10px] leading-relaxed text-slate-400">{analysis?.risk_explanation || (snapshot ? `National index averages ${snapshot.account_count} account-context network scores; highest linked cohort is ${snapshot.peak_cohort_risk_score ?? "—"}/100. This is a ranking index, not a probability.` : "Waiting for the national transaction graph.")}</p>
        {analysis && <ExplainabilityBlock analysis={analysis}/>}
        <div className="mt-auto grid grid-cols-2 gap-2 pt-2">
          <div className="rounded-md border border-white/[.06] bg-black/10 px-2.5 py-2"><div className="text-[8px] tracking-wider text-slate-600">COHORT SIZE</div><div className="mt-1 font-mono text-[12px] text-slate-300">{analysis?.network?.account_count ?? snapshot?.account_count ?? "—"} <span className="text-[9px] text-slate-600">accounts</span></div></div>
          <div title={routes.length ? "Routes use explicit source_country and target_country fields." : "Country coverage is shown here; a transfer route requires explicit source_country and target_country fields."} className="min-w-0 rounded-md border border-white/[.06] bg-black/10 px-2.5 py-2"><div className="text-[8px] tracking-wider text-slate-600">{geographyLabel}</div><div className="mt-1 truncate font-mono text-[11px] text-slate-300">{geography}</div></div>
        </div>
        <form className="mt-2 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); onAnalyze(input); }}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Account ID · ACC_097" className="h-8 min-w-0 flex-1 rounded-md border border-white/[.08] bg-black/20 px-2.5 font-mono text-[10px] text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-200/35"/><Button type="submit" className="h-8 px-2.5 text-[9px]">ANALYZE</Button></form>
      </div>
    </div>
  </Panel>;
}

function ExplainabilityBlock({ analysis }: { analysis: AccountAnalysis }) {
  const gnn = analysis.gnn;
  const drivers = analysis.explanation?.account_drivers || [];
  const network = analysis.explanation?.network_adjustments || {};
  const uplift = Number(network.linked_network_bonus || 0) + Number(network.shared_ip_bonus || 0) + Number(network.cross_border_context_bonus || 0);
  const hasGnnScore = Boolean(gnn?.available && typeof gnn.score === "number");
  const ruleWeight = Number(analysis.score_components?.rules_weight ?? 1);
  const gnnWeight = Number(analysis.score_components?.gnn_weight ?? 0);
  const blendLabel = hasGnnScore ? `${Math.round(ruleWeight * 100)}% account rules + ${Math.round(gnnWeight * 100)}% GNN` : "Graph rules only";
  const scoreMath = analysis.explanation?.score_math;
  const beforeCap = scoreMath ? scoreMath.base_score + scoreMath.network_uplift : 0;
  const deviations = gnn?.feature_deviations || [];
  const adjustments = [
    { label: "Linked cohort", points: network.linked_network_bonus },
    { label: "Shared IP", points: network.shared_ip_bonus },
    { label: "Cross-border", points: network.cross_border_context_bonus },
  ].filter((item): item is { label: string; points: number } => typeof item.points === "number");

  return <section aria-label="Risk score explanation" className="terminal-scroll mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-cyan-200/[.11] bg-cyan-200/[.025] px-2.5 py-2">
    <div className="flex items-center justify-between gap-2"><div className="text-[8px] font-bold tracking-[.13em] text-cyan-100/75">WHY THIS NETWORK SCORE?</div><span className="font-mono text-[7px] tracking-wider text-slate-500">RANKING INDEX - NOT PROBABILITY</span></div>
    {scoreMath && <div className="mt-2 rounded border border-white/[.06] bg-black/10 px-2 py-1.5">
      <div className="text-[7px] font-bold tracking-[.12em] text-slate-500">SCORE PATH</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="min-w-0"><div className="text-[8px] text-slate-500">BASE SIGNAL</div><div className="break-words text-[9px] leading-snug text-slate-300">{scoreMath.base_label} ({scoreMath.base_account_id})</div></div>
        <div className="shrink-0 font-mono text-[11px] font-semibold text-slate-200">{scoreMath.base_score}<span className="text-[8px] text-slate-600">/100</span></div>
      </div>
      {adjustments.length > 0 && <div className="mt-1.5 grid grid-cols-3 gap-1">{adjustments.map((item) => <div key={item.label} className="min-w-0 rounded border border-white/[.05] bg-white/[.02] px-1.5 py-1"><div className="truncate text-[7px] text-slate-500">{item.label}</div><div className="font-mono text-[9px] text-cyan-100/80">+{item.points} pts</div></div>)}</div>}
      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-white/[.06] pt-1.5"><div><div className="text-[7px] font-bold tracking-[.12em] text-cyan-100/65">FINAL NETWORK SCORE</div><div className="text-[7px] text-slate-500">Base signal plus network adjustments</div></div><div className="shrink-0 text-right font-mono text-[12px] font-semibold text-cyan-100">{scoreMath.network_score}<span className="text-[8px] text-slate-500">/100</span>{beforeCap > scoreMath.network_score && <div className="text-[7px] font-normal text-amber-200/80">Capped at {scoreMath.capped_at}</div>}</div></div>
    </div>}
    {drivers.length > 0 && <div className="mt-2">
      <div className="text-[7px] font-bold tracking-[.12em] text-slate-500">TOP CONTRIBUTING ACCOUNT SIGNALS</div>
      <ul className="mt-1 space-y-0.5">{drivers.slice(0, 3).map((item) => <li key={item.factor} className="flex items-center justify-between gap-2 border-b border-white/[.04] py-1 text-[9px]"><span className="min-w-0 break-words text-slate-400">{item.factor}</span><span className="shrink-0 font-mono text-cyan-100/80">+{item.points} pts</span></li>)}</ul>
    </div>}
    <div className="mt-2 border-t border-white/[.05] pt-1.5">
      <div className="flex items-center justify-between gap-2"><div className="text-[8px] text-slate-400">GNN ANOMALY RANK · NOT FRAUD PROBABILITY</div><div className="shrink-0 font-mono text-[9px] font-semibold text-slate-200">{hasGnnScore ? `${gnn?.score}/100` : "RULES ONLY"}</div></div>
      {hasGnnScore && <div title={gnn?.confidence_basis || "The GNN evidence-strength percentage is uncalibrated and is not a probability."} className="mt-0.5 text-[7px] text-slate-500">Evidence strength: {Math.round((gnn?.confidence || 0) * 100)}% · uncalibrated</div>}
      {hasGnnScore && <div title={gnn?.confidence_basis || "The GNN rank is calibrated against normal-only embedding-distance data; its evidence-strength percentage is uncalibrated and is not a probability."} className="mt-1 h-1 overflow-hidden rounded bg-white/[.06]"><div className="h-full rounded bg-gradient-to-r from-cyan-300 to-amber-300" style={{ width: `${Math.min(100, Number(gnn?.score || 0))}%` }}/></div>}
      {!hasGnnScore && gnn?.error && <div title={gnn.error} className="mt-1 text-[8px] text-amber-200/80">GNN unavailable; graph rules remain active.</div>}
      {deviations.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{deviations.slice(0, 2).map((item) => <span key={item.feature} className="rounded border border-white/[.06] bg-black/10 px-1.5 py-1 text-[7px] text-slate-400">{item.feature} · z {item.z_score > 0 ? "+" : ""}{item.z_score}</span>)}</div>}
      <div title={analysis.explanation?.method} className="mt-1.5 text-[7px] text-slate-600">{blendLabel}{!hasGnnScore && gnn?.error ? " · GNN unavailable" : ""} · network uplift +{uplift} pts</div>
    </div>
  </section>;
}

function TransactionLedger({ transactions, onAnalyze, title = "TRANSACTION ACTIVITY" }: { transactions: Transaction[]; onAnalyze: (account: string) => void; title?: string }) {
  const [expanded, setExpanded] = useState(false);
  const displayed = expanded ? transactions : transactions.slice(0, 9);
  return <Panel className="h-[360px]"><div className="flex h-full flex-col"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.06] px-4 py-2.5"><div className="flex items-center gap-2"><Layers3 size={14} className="text-cyan-200"/><span className="text-[10px] font-bold tracking-[.14em] text-slate-300">{title}</span></div><span className="flex items-center gap-1.5 text-[8px] text-slate-600"><i className="signal-pulse h-1.5 w-1.5 rounded-full bg-emerald-300"/>{transactions.some((tx) => tx.source_provider === "OBP") ? "BANK SOURCE EVENTS" : "OBSERVED WORKSPACE RECORDS"}</span></div>
    <div className="grid grid-cols-[84px_minmax(0,1fr)_100px] gap-2 border-b border-white/[.04] px-4 py-2 text-[8px] font-bold tracking-[.13em] text-slate-700"><span>TIME / REF</span><span>NETWORK PATH</span><span className="text-right">VALUE</span></div>
    <div className="terminal-scroll flex-1 overflow-auto">{transactions.length === 0 ? <div className="grid h-full place-items-center text-[10px] text-slate-600">No transactions received from the connected source.</div> : displayed.map((tx, index) => <div key={`${tx.transaction_id}-${index}`} className="grid grid-cols-[84px_minmax(0,1fr)_100px] items-center gap-2 border-b border-white/[.035] px-4 py-2.5 hover:bg-white/[.025]"><div><div className="font-mono text-[9px] text-slate-400">{new Date(tx.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</div><div className="mt-1 truncate font-mono text-[8px] text-slate-700">{tx.transaction_id}</div></div><div className="min-w-0"><div className="flex min-w-0 items-center gap-1.5"><button onClick={() => onAnalyze(tx.source_account)} className="truncate font-semibold text-cyan-100/80 hover:text-cyan-100">{tx.source_name || tx.source_account}</button><ArrowUpRight size={10} className="shrink-0 text-slate-700"/><button onClick={() => onAnalyze(tx.target_account)} className="truncate font-semibold text-slate-300 hover:text-white">{tx.target_name || tx.target_account}</button></div><div className="mt-1 truncate text-[8px] text-slate-600">{[tx.source_country && tx.target_country ? `${tx.source_country} → ${tx.target_country}` : tx.location_country ? `${tx.location || "LOCATION"} · ${tx.location_country}` : tx.location, tx.device_id, tx.ip_address, tx.currency && tx.currency !== "INR" ? `Settlement ${tx.currency}` : null, tx.instructed_currency && tx.currency !== tx.instructed_currency ? `Instruction ${tx.instructed_currency}` : null, tx.source_provider].filter(Boolean).join(" · ") || "No device or geo metadata"}</div></div><div className="text-right"><div className="font-mono text-[10px] text-slate-200">{formatCurrency(tx.amount, tx.currency || "INR")}</div>{typeof tx.amount_inr === "number" && tx.currency !== "INR" && <div className="mt-1 font-mono text-[8px] text-slate-500">≈ ₹{tx.amount_inr.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>}<div className="mt-1 text-[8px] text-slate-600">{tx.ip_address ? "IP LINKED" : "NO IP"}</div></div></div>)}</div>
    <div className="flex items-center justify-between gap-2 border-t border-white/[.05] px-4 py-2 text-[8px] text-slate-600"><span>{displayed.length} of {transactions.length} recent graph events{transactions.some((tx) => tx.fx_rate_source) && <> · <a href="https://www.exchangerate-api.com/docs/free" target="_blank" rel="noreferrer" className="text-slate-500 underline decoration-white/10 underline-offset-2 hover:text-cyan-100">Daily reference FX by ExchangeRate-API</a></>}</span><button type="button" disabled={transactions.length <= 9} onClick={() => setExpanded((value) => !value)} className="shrink-0 text-cyan-100/60 hover:text-cyan-100 disabled:cursor-default disabled:text-slate-700">{expanded ? "SHOW RECENT" : "SHOW ALL RECORDS"} <ArrowDownRight size={10} className="ml-1 inline"/></button></div></div></Panel>;
}

function TickerTape({ rows, onAnalyze }: { rows: Transaction[]; onAnalyze: (account: string) => void }) {
  const items = rows.length ? rows : [];
  const repeated = items.length ? [...items, ...items] : [];
  return <div className="relative w-full min-w-0 overflow-hidden"><div className="ticker-marquee flex w-max items-center gap-4">{repeated.length ? repeated.map((tx, index) => <span key={`${tx.transaction_id}-${index}`} title={`${tx.transaction_id} · ${new Date(tx.timestamp).toLocaleString("en-IN")}`} className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[8px]"><button type="button" onClick={() => onAnalyze(tx.source_account)} aria-label={`Investigate source account ${tx.source_account}`} className="text-slate-500 transition hover:text-cyan-100">{tx.source_account}</button><ArrowUpRight size={9} className="text-cyan-100/50"/><button type="button" onClick={() => onAnalyze(tx.target_account)} aria-label={`Investigate target account ${tx.target_account}`} className="text-slate-400 transition hover:text-cyan-100">{tx.target_account}</button><span className="text-slate-600">{formatCurrency(tx.amount, tx.currency || "INR")}</span><span className="mx-1 h-1 w-1 rounded-full bg-slate-700"/></span>) : <span className="whitespace-nowrap font-mono text-[8px] text-slate-700">AWAITING CONNECTED TRANSACTION SOURCE</span>}</div></div>;
}

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${Number(amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })} ${currency}`;
  }
}

function FingerprintIcon({ size, className }: { size?: number; className?: string }) { return <Settings2 size={size} className={className}/>; }
