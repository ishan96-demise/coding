import { Activity, Fingerprint, Globe2, ShieldAlert, Smartphone, UserRound } from "lucide-react";
import type { AccountRiskSignal, NetworkNode } from "@/lib/types";

const safe = "#06B6D4";
const watch = "#F59E0B";
const high = "#EF4444";

export function NodeInspector({
  node,
  signal,
  onInvestigate,
}: {
  node: NetworkNode | null;
  signal?: AccountRiskSignal;
  onInvestigate: (accountId: string) => void;
}) {
  if (!node) {
    return (
      <aside className="flex min-h-[240px] shrink-0 flex-col border-l border-white/[.06] p-3">
        <InspectorHeading />
        <div className="grid flex-1 place-items-center px-3 text-center text-[9px] leading-relaxed text-slate-600">
          Select an account, device, IP, or location in the graph to inspect its linked evidence.
        </div>
      </aside>
    );
  }

  const isAccount = node.type === "account";
  const score = signal?.risk_score;
  const networkScore = signal?.network_risk_score ?? score;
  const status = (signal?.status || "").toUpperCase();
  const isHigh = isAccount && status.includes("HIGH");
  const isWatch = isAccount && !isHigh && (status.includes("WATCH") || status.includes("MEDIUM") || Boolean(signal?.in_fraud_ring) || Boolean(signal?.mule_account));
  const tone = isHigh ? high : isWatch ? watch : safe;
  const flowRatio = signal?.flow_metrics?.pass_through_ratio;
  const flowRatioLabel = flowRatio === undefined ? "—" : `${(flowRatio * 100).toFixed(1)}%`;

  return (
    <aside className="flex min-h-[240px] min-w-0 shrink-0 flex-col border-l border-white/[.06] p-3">
      <InspectorHeading />
      <div className="mt-4 flex items-center gap-2">
        <EntityIcon type={node.type} color={tone} />
        <span className="text-[8px] font-bold uppercase tracking-[.14em] text-slate-500">{node.type.replaceAll("_", " ")}</span>
      </div>
      <div className="mt-2 break-all font-mono text-[12px] font-semibold text-slate-100">{node.label || node.id}</div>
      <div className="mt-1 break-all font-mono text-[8px] text-slate-600">{node.id}</div>

      <div className="mt-4 space-y-2 border-t border-white/[.06] pt-3">
        <Metric label="CONNECTIONS" value={node.connection_count} />
        <Metric label="LINKED ACCOUNTS" value={node.type === "account" ? "—" : node.shared_account_count} />
        {isAccount && <>
          <Metric label="FOCUSED ACCOUNT NETWORK SCORE" value={networkScore === undefined ? "SYNCING" : `${networkScore}/100`} color={tone} />
          {signal?.account_risk_score !== undefined && <Metric label="ACCOUNT BASE SCORE" value={`${signal.account_risk_score}/100`} />}
          <Metric label="MODEL CLASSIFICATION" value={signal?.status || "SYNCING"} color={tone} />
          <Metric label="MULE FLOW" value={signal ? (signal.mule_account ? "INDICATED" : "NOT INDICATED") : "SYNCING"} color={signal?.mule_account ? watch : undefined} />
          <Metric label="PASS-THROUGH FLOW RATIO" value={flowRatioLabel} />
          <Metric label="GNN ANOMALY EVIDENCE STRENGTH" value={signal?.gnn?.available && signal.gnn.confidence !== undefined ? `${Math.round(signal.gnn.confidence * 100)}% · UNCALIBRATED` : "UNAVAILABLE"} />
          {signal?.gnn?.available && <div title={signal.gnn.confidence_basis || "Derived from normalized embedding distance against the normal-only reference set; not a probability."} className="text-[7px] leading-relaxed text-slate-600">Embedding distance vs normal baseline. This percentage is not a fraud probability.</div>}
          {signal?.in_fraud_ring && <div className="rounded border border-amber-400/15 bg-amber-400/[.04] px-2 py-1.5 text-[8px] text-amber-300">Circular flow evidence · {signal.cycle_count || 1} cycle{signal.cycle_count === 1 ? "" : "s"}</div>}
        </>}
      </div>

      {isAccount && <button
        type="button"
        onClick={() => onInvestigate(node.id)}
        className="mt-3 shrink-0 rounded-md border border-cyan-500/20 bg-cyan-500/[.06] px-2 py-2 text-[9px] font-semibold tracking-wider text-cyan-200 transition hover:bg-cyan-500/[.12]"
      >
        OPEN ACCOUNT INVESTIGATION
      </button>}
    </aside>
  );
}

function InspectorHeading() {
  return <div className="flex items-center justify-between gap-2">
    <div className="text-[8px] font-bold tracking-[.15em] text-slate-500">NODE INSPECTOR</div>
    <span className="rounded border border-white/[.06] px-1.5 py-0.5 font-mono text-[7px] text-slate-600">FASTAPI</span>
  </div>;
}

function EntityIcon({ type, color }: { type: string; color: string }) {
  const Icon = type === "account" ? UserRound : type === "device" ? Smartphone : type === "ip_address" ? Fingerprint : type === "location" ? Globe2 : Activity;
  return <Icon size={13} style={{ color }} aria-hidden="true" />;
}

function Metric({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
    <span className="min-w-0 break-words text-[7px] font-semibold leading-relaxed tracking-[.08em] text-slate-600">{label}</span>
    <span className="max-w-[100px] break-words text-right font-mono text-[9px] leading-relaxed text-slate-300" style={color ? { color } : undefined}>{value}</span>
  </div>;
}
