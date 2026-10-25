"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ArrowRight, BriefcaseBusiness, CircleUserRound, LayoutDashboard, LoaderCircle, LogOut, Network, Settings2, ShieldCheck, ArrowLeftRight } from "lucide-react";
import { Brand } from "@/components/site-chrome";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

export type PortalAccount = { account_id: string; name: string; currency: string; balance: number; balance_label: string; transaction_count: number; is_synthetic: boolean };
export type PortalUser = { id: number; email: string; name: string; role: "customer" };
type PortalContextValue = { user: PortalUser; accounts: PortalAccount[]; reload: () => Promise<void> };
const PortalContext = createContext<PortalContextValue | null>(null);

export function usePortal() {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortal must be used inside PortalShell");
  return value;
}

type PortalSection = "overview" | "transactions" | "intelligence" | "cases" | "settings";

const nav: { href: string; label: string; icon: typeof LayoutDashboard; key: PortalSection }[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, key: "overview" },
  { href: "/dashboard/transactions", label: "Transactions", icon: ArrowLeftRight, key: "transactions" },
  { href: "/dashboard/intelligence", label: "Network & signals", icon: Network, key: "intelligence" },
  { href: "/dashboard/cases", label: "My cases", icon: BriefcaseBusiness, key: "cases" },
  { href: "/dashboard/settings", label: "Settings", icon: Settings2, key: "settings" },
];

export function PortalShell({ active, title, subtitle, children }: { active: PortalSection; title: string; subtitle: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<PortalUser | null>(null);
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = async () => {
    setError("");
    try {
      const response = await fetch("/api/portal/me", { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.replace(`/login?next=${encodeURIComponent(pathname || "/dashboard")}`);
        return;
      }
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "We could not load your workspace.");
      setUser(payload.user as PortalUser);
      setAccounts(Array.isArray(payload.accounts) ? payload.accounts as PortalAccount[] : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The customer workspace is unavailable.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [pathname]);
  const context = useMemo(() => user ? { user, accounts, reload } : null, [user, accounts]);

  const logout = async () => {
    await fetch("/api/portal/logout", { method: "POST", cache: "no-store", credentials: "same-origin" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="portal-shell">
      <header className="portal-topbar">
        <div className="portal-topbar-main"><Brand /><span className="portal-workspace-label">Customer workspace</span></div>
        <div className="portal-user-actions"><WorkspaceSwitcher active="customer" /><ThemeToggle />{user && <span className="portal-user-chip"><CircleUserRound size={17}/><span>{user.name}</span></span>}<button className="portal-logout" type="button" onClick={logout}><LogOut size={16}/><span>Sign out</span></button></div>
      </header>
      <div className="portal-layout">
        <aside className="portal-sidebar" aria-label="Customer navigation">
          <div className="portal-side-label">Workspace</div>
          {nav.map((item) => {
            const Icon = item.icon;
            const selected = active === item.key;
            return <Link key={item.href} href={item.href} className={`portal-nav-link ${selected ? "selected" : ""}`}><Icon size={17}/><span>{item.label}</span>{selected && <ArrowRight size={14} className="portal-nav-arrow"/>}</Link>;
          })}
          <div className="portal-sidebar-note"><ShieldCheck size={17}/><div><strong>Your sample data stays scoped</strong><span>Only accounts linked to this login appear here.</span></div></div>
          <Link href="/" className="portal-back-link">Back to Fin Sentinels</Link>
        </aside>
        <main className="portal-main">
          <div className="portal-page-heading"><div><p className="portal-breadcrumb">Customer workspace <span>/</span> {title}</p><h1>{title}</h1><p>{subtitle}</p></div><div className="portal-synthetic-badge"><i/> Synthetic demo data</div></div>
          {loading ? <div className="portal-state-card"><LoaderCircle size={20} className="spin"/><span>Loading your workspace…</span></div> : error ? <div className="portal-state-card portal-state-error" role="alert"><div><strong>We couldn’t load your workspace.</strong><p>{error}</p></div><button className="button button-outline" onClick={() => { setLoading(true); void reload(); }}>Try again</button></div> : user && context ? <PortalContext.Provider value={context}>{children}</PortalContext.Provider> : null}
        </main>
      </div>
    </div>
  );
}
