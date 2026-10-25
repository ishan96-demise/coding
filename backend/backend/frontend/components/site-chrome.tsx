import Link from "next/link";
import { Menu, ShieldCheck } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher, type Workspace } from "@/components/workspace-switcher";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand-mark" aria-label="Fin Sentinels home">
      <span className="brand-icon"><ShieldCheck size={20} strokeWidth={2.1} aria-hidden="true" /></span>
      <span className="brand-copy"><strong>Fin Sentinels</strong>{!compact && <small>Financial network insights</small>}</span>
    </Link>
  );
}

export function SiteHeader({ active, workspace = "public" }: { active?: string; workspace?: Workspace }) {
  return (
    <header className="site-header">
      <div className="site-container site-header-inner">
        <Brand />
        <nav className="site-nav" aria-label="Main navigation">
          <Link className={active === "platform" ? "active" : ""} href="/#how-it-works">Platform</Link>
          <Link href="/#security">Security</Link>
          <Link className="site-analyst-link" href="/analyst-login?next=%2Fterminal">Analyst sign in <span aria-hidden="true">→</span></Link>
        </nav>
        <WorkspaceSwitcher active={workspace} />
        <details className="site-mobile-menu">
          <summary aria-label="Open site navigation"><Menu size={19} /><span>Menu</span></summary>
          <nav aria-label="Mobile navigation">
            <Link href="/#how-it-works">Platform</Link><Link href="/#security">Security</Link><Link href="/analyst-login">Analyst sign in</Link><Link href="/login">Customer login</Link><Link href="/signup">Create account</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link>
          </nav>
        </details>
        <div className="site-header-actions">
          <ThemeToggle />
          <Link className="site-login-link" href="/login">Customer login</Link>
          <Link className="button button-primary button-small" href="/signup">Create account</Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container site-footer-inner">
        <div><Brand compact /><p className="footer-note">A clear view of transaction relationships, built for careful review.</p></div>
        <div className="footer-links" aria-label="Footer links">
          <Link href="/analyst-login">Analyst workspace</Link><Link href="/login">Customer login</Link><Link href="/about">About</Link><Link href="/contact">Contact</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link>
        </div>
        <p className="footer-disclaimer">Early-access software using synthetic transaction data. It is not a bank and does not move money.</p>
      </div>
    </footer>
  );
}

export function SiteFrame({ children, active, workspace }: { children: React.ReactNode; active?: string; workspace?: Workspace }) {
  return <div className="site-shell"><SiteHeader active={active} workspace={workspace} /><main>{children}</main><SiteFooter /></div>;
}
