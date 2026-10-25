import Link from "next/link";
import { ChevronDown, Globe2, Network, ShieldCheck } from "lucide-react";

export type Workspace = "public" | "customer" | "analyst";

const icons = { public: Globe2, customer: Network, analyst: ShieldCheck };
const labels: Record<Workspace, string> = {
  public: "Public site",
  customer: "Customer portal",
  analyst: "Analyst terminal",
};

export function WorkspaceSwitcher({ active }: { active: Workspace }) {
  const customerHref = active === "customer" ? "/dashboard" : "/login?next=%2Fdashboard";
  const analystHref = active === "analyst" ? "/terminal" : "/analyst-login?next=%2Fterminal";
  const workspaces: { id: Workspace; href: string; description: string }[] = [
    { id: "public", href: "/", description: "Product overview and platform details" },
    {
      id: "customer",
      href: customerHref,
      description: active === "customer" ? "Your linked accounts, activity, and cases" : "Customer sign in · create an account if you’re new",
    },
    {
      id: "analyst",
      href: analystHref,
      description: active === "analyst" ? "Global network, signals, and case queue" : "Analyst sign in for the protected terminal",
    },
  ];
  const CurrentIcon = icons[active];

  return (
    <details className="workspace-switcher">
      <summary aria-label={`Current workspace: ${labels[active]}. Open workspace switcher`}>
        <CurrentIcon size={15} aria-hidden="true" />
        <span>{labels[active]}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <nav className="workspace-menu" aria-label="Choose a workspace">
        <p className="workspace-menu-title">Choose a workspace</p>
        {workspaces.map(({ id, href, description }) => {
          const Icon = icons[id];
          return (
            <Link key={id} href={href} aria-current={id === active ? "page" : undefined}>
              <Icon size={16} aria-hidden="true" />
              <span className="workspace-option-copy">
                <strong>{labels[id]}</strong>
                <small>{description}</small>
              </span>
              {id === active && <span className="workspace-current-label">Current</span>}
            </Link>
          );
        })}
        {active !== "customer" && (
          <div className="workspace-menu-footer">
            <span>New customer?</span>
            <Link href="/signup?next=%2Fdashboard">Create an account</Link>
          </div>
        )}
      </nav>
    </details>
  );
}
