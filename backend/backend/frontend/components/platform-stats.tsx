"use client";

import { useEffect, useState } from "react";

type PublicSummary = {
  data_mode: "demo" | "production";
  public_stats_available: boolean;
  accounts_monitored?: number;
  transfer_records?: number;
  last_activity?: string | null;
};

export function PlatformStats() {
  const [summary, setSummary] = useState<PublicSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/public/summary", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !payload || typeof payload !== "object") {
          throw new Error("The public sample metrics are unavailable right now.");
        }
        if (active) setSummary(payload as PublicSummary);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "The public sample metrics are unavailable right now.");
      });
    return () => { active = false; };
  }, []);

  if (error) return <p className="platform-stats-state" role="status">{error} The workspace preview remains available.</p>;
  if (!summary) return <p className="platform-stats-state" role="status">Loading aggregate sample activity…</p>;
  if (!summary.public_stats_available) return <p className="platform-stats-state" role="status">Public activity counts are disabled outside the synthetic preview.</p>;

  const lastActivity = summary.last_activity
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(summary.last_activity))
    : "No sample activity yet";

  return (
    <div className="preview-metrics customer-preview-metrics" aria-label="Live synthetic platform statistics">
      <article><span>Accounts in sample</span><strong>{summary.accounts_monitored?.toLocaleString() ?? "—"}</strong><small>Aggregate count</small></article>
      <article><span>Transfer records</span><strong>{summary.transfer_records?.toLocaleString() ?? "—"}</strong><small>Aggregate count</small></article>
      <article><span>Latest sample activity</span><strong className="preview-date-value">{lastActivity}</strong><small>From the synthetic dataset</small></article>
    </div>
  );
}
