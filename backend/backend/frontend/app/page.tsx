import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, BadgeCheck, CircleHelp, Fingerprint, GitFork, LockKeyhole, ScanSearch, ShieldCheck } from "lucide-react";
import { SiteFrame } from "@/components/site-chrome";
import { PlatformStats } from "@/components/platform-stats";

export const metadata: Metadata = {
  title: "Fin Sentinels | Financial intelligence workspace",
  description: "Explore account relationships, explainable transaction signals, and case management in a synthetic-data workspace.",
};

const faq = [
  ["Is this connected to my bank?", "No. The current preview uses synthetic transaction data. Live bank connections are not available."],
  ["Does a review signal mean fraud?", "No. Signals show observable patterns and the records behind them. They are not fraud probabilities or automatic decisions."],
  ["Can customers see the full analyst network?", "No. Customers see only their linked accounts and transactions. Outside counterparties are grouped without showing their account IDs."],
  ["How is an account risk score produced?", "The score combines visible transaction and network evidence under review rules. Each explanation names the factors that contributed. It is a ranking aid, not a calibrated probability or a decision."],
  ["What is recorded when a customer reviews activity?", "Customer portal reads and case actions are stored with the actor and resource in an audit record. Entries are linked with cryptographic hashes, so changing a record breaks chain verification. A production system should anchor checkpoints outside the database and protect its backups."],
  ["What is the system architecture?", "Transaction records are normalized, represented as a relationship graph, scored with explainable rules, and presented in a role-scoped workspace. The demo uses local synthetic data and a SQLite customer store."],
];

export default function HomePage() {
  return (
    <SiteFrame active="platform">
      <section className="site-container hero-section" id="platform">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-dot" /> Financial intelligence workspace</p>
          <h1>See the relationships behind a transaction.</h1>
          <p className="hero-lede">Connect transaction activity, account links, explainable signals, and case follow-up in one investigation workflow.</p>
          <div className="hero-actions"><Link className="button button-primary" href="/analyst-login">Open analyst workspace <ArrowRight size={17} /></Link><Link className="button button-quiet" href="/login">Customer login</Link></div>
          <p className="hero-note"><ShieldCheck size={15} /> Synthetic preview only. No banking credentials or live payments.</p>
        </div>

        <div className="product-preview" id="activity-at-a-glance" aria-label="Illustrative customer activity preview">
          <div className="preview-top"><div><span className="preview-kicker">Illustrative customer view</span><h2>Activity at a glance</h2></div><span className="preview-status"><i /> Sample data</span></div>
          <PlatformStats />
          <div className="preview-network" role="img" aria-label="Illustration of two linked customer accounts and grouped outside activity">
            <svg viewBox="0 0 560 150" aria-hidden="true"><line x1="105" y1="77" x2="279" y2="77"/><line x1="279" y1="77" x2="455" y2="77"/><circle cx="105" cy="77" r="25"/><circle cx="279" cy="77" r="25"/><circle cx="455" cy="77" r="25"/><text x="105" y="81" textAnchor="middle">A1</text><text x="279" y="81" textAnchor="middle">A2</text><text x="455" y="81" textAnchor="middle">↔</text><text x="105" y="126" textAnchor="middle">Your account</text><text x="279" y="126" textAnchor="middle">Your account</text><text x="455" y="126" textAnchor="middle">Outside activity</text></svg>
          </div>
          <div className="preview-feed">
            <div className="preview-feed-heading"><span>Recent sample activity</span><Link href="/signup">Explore customer view <ArrowRight size={13}/></Link></div>
            <div className="feed-row"><span className="feed-icon in"><ArrowDownLeft size={16}/></span><span className="feed-name"><strong>Incoming transfer</strong><small>Account A1 · sample record</small></span><strong className="feed-value">+₹4,820</strong><BadgeCheck size={16} className="feed-check"/></div>
            <div className="feed-row"><span className="feed-icon out"><ArrowUpRight size={16}/></span><span className="feed-name"><strong>Outgoing transfer</strong><small>Account A2 · sample record</small></span><strong className="feed-value">−₹2,150</strong><BadgeCheck size={16} className="feed-check"/></div>
          </div>
          <p className="preview-caption">The public counts above are aggregate synthetic sample metrics. A signed-in customer sees records linked to their own workspace.</p>
        </div>
      </section>

      <section className="trust-strip"><div className="site-container trust-strip-inner"><span><LockKeyhole size={17}/> Customer data stays scoped</span><span><Fingerprint size={17}/> Synthetic records in this preview</span><span><ScanSearch size={17}/> Evidence behind each signal</span></div></section>

      <section className="site-container content-section" id="how-it-works">
        <div className="section-heading"><p className="eyebrow">How it works</p><h2>From transaction ingestion to evidence-led review.</h2><p>Each step keeps the underlying records close to the graph and the explanation, with separate customer and analyst access.</p></div>
        <div className="steps-grid"><article className="step-card"><span className="step-number">01</span><div className="step-icon"><ArrowDownLeft size={20}/></div><h3>Ingest transaction records</h3><p>Normalize activity into consistent account, amount, direction, time, and status fields. The current public preview runs on synthetic records.</p></article><article className="step-card"><span className="step-number">02</span><div className="step-icon"><GitFork size={20}/></div><h3>Build the relationship graph</h3><p>Connect accounts through observed transfers and shared attributes such as devices or IP addresses, while retaining the source evidence.</p></article><article className="step-card"><span className="step-number">03</span><div className="step-icon"><ScanSearch size={20}/></div><h3>Score, explain, and review</h3><p>Apply visible evidence rules, show the contributing factors, and let a customer report an item for human case review.</p></article></div>
      </section>

      <section className="feature-band" id="useful-starting-point"><div className="site-container feature-band-inner"><div><p className="eyebrow">A useful starting point</p><h2>Keep the transaction, its evidence, and its case together.</h2><p className="section-copy">Fin Sentinels is a prototype for reviewing financial relationships. Customer workspaces show only linked accounts. Analysts use a separate protected workspace for the global sample network.</p><Link className="text-link" href="/analyst-login">Open analyst sign in <ArrowRight size={16}/></Link></div><div className="feature-list"><article><span className="feature-check">✓</span><div><h3>Account network</h3><p>Explore a graph of linked accounts and grouped outside activity.</p></div></article><article><span className="feature-check">✓</span><div><h3>Explainable signals</h3><p>Review the visible rules and transaction evidence behind each indicator.</p></div></article><article><span className="feature-check">✓</span><div><h3>Case follow-up</h3><p>Send a transaction for review and track your own submitted cases.</p></div></article></div></div></section>

      <section className="site-container security-section" id="security">
        <div className="security-section-heading"><div className="security-icon"><ShieldCheck size={24}/></div><div><p className="eyebrow">Security and responsible use</p><h2>Make data boundaries visible and reviewable.</h2><p>This preview uses synthetic records. These controls describe the prototype behavior; they are not a claim of certification or approval for real financial data.</p></div><Link className="button button-outline" href="/privacy">Read privacy notes</Link></div>
        <div className="security-detail-grid">
          <article><LockKeyhole size={19}/><h3>Customer data stays scoped</h3><p>Portal requests are filtered by the signed-in user’s linked accounts on the backend. The customer interface does not receive the analyst-wide risk matrix.</p></article>
          <article><GitFork size={19}/><h3>Outside accounts are masked</h3><p>In the customer graph, counterparties outside the customer’s linked accounts are grouped into a single generic node. Analysts use a separate protected view.</p></article>
          <article><Fingerprint size={19}/><h3>Customer reviews leave a trace</h3><p>Customer portal reads and case actions record the actor and resource in a SHA-256 hash-linked trail. Editing a record breaks chain verification; production needs protected storage, external checkpoints, and controlled backups.</p></article>
          <article><ShieldCheck size={19}/><h3>Use synthetic data here</h3><p>No bank credentials or live customer records belong in this preview. A real deployment requires independent security, privacy, legal, and data-source review.</p></article>
        </div>
      </section>

      <section className="site-container faq-section" id="questions"><div className="section-heading"><p className="eyebrow">Questions</p><h2>Before you explore</h2></div><div className="faq-list">{faq.map(([question, answer]) => <details key={question}><summary><span>{question}</span><CircleHelp size={18}/></summary><p>{answer}</p></details>)}</div></section>

      <section className="site-container bottom-cta" id="explore-preview"><div><p className="eyebrow">Explore the preview</p><h2>Choose the workspace for your role.</h2><p>Analysts can review the global sample network. Customers can inspect their own linked accounts and report transactions.</p></div><div className="hero-actions"><Link className="button button-primary" href="/analyst-login">Analyst sign in <ArrowRight size={17}/></Link><Link className="button button-outline" href="/login">Customer login</Link></div></section>
    </SiteFrame>
  );
}
