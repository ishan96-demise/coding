import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-chrome";

export const metadata: Metadata = { title: "Privacy | Fin Sentinels", description: "Privacy notes for the Fin Sentinels synthetic-data preview." };

export default function PrivacyPage() {
  return <SiteFrame><article className="site-container legal-page"><p className="eyebrow">Privacy</p><h1>Privacy notes for this preview</h1><p className="legal-updated">Last updated: 25 October 2026</p><div className="legal-callout">This is an early product preview. It uses synthetic transaction records and is not approved for real banking or customer data.</div>
    <h2>Information you provide</h2><p>If you create an account, the local service stores your name, email address, a password hash, a session record, and the synthetic account links assigned to your workspace. Passwords are not stored as readable text.</p>
    <h2>Transaction information</h2><p>The transaction history in this preview is synthetic. Do not upload real statements, credentials, or personal financial information. Customer account access is scoped to the synthetic accounts linked to that customer account.</p>
    <h2>How information is used</h2><p>Workspace details are used to authenticate your session and show your sample accounts and transactions. The prototype may record audit events for actions such as viewing account activity or reporting a transaction.</p>
    <h2>Storage and deletion</h2><p>Local development stores portal data in a SQLite file on the application host. This preview does not yet provide a self-service account deletion flow. Production retention, deletion, backups, and data-subject processes must be defined before real data is collected.</p>
    <h2>Security and contact</h2><p>The prototype includes password hashing and httpOnly session cookies, but it has not been independently audited or approved for production financial data. For privacy questions, use the configured contact address on the <a href="/contact">contact page</a> when one is available.</p>
  </article></SiteFrame>;
}
