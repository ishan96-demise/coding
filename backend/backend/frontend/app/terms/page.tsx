import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-chrome";

export const metadata: Metadata = { title: "Terms | Fin Sentinels", description: "Terms for using the Fin Sentinels early-access preview." };

export default function TermsPage() {
  return <SiteFrame><article className="site-container legal-page"><p className="eyebrow">Terms</p><h1>Terms for the early-access preview</h1><p className="legal-updated">Last updated: 25 October 2026</p><div className="legal-callout">This preview is for product evaluation with synthetic data. It is not a bank, payment service, fraud determination, or source of financial advice.</div>
    <h2>Use of the preview</h2><p>You may use the workspace to explore the features described on this site. You are responsible for keeping your account password private and using the preview lawfully.</p>
    <h2>No real financial decisions</h2><p>Risk scores and explanations are prototype signals. They are not calibrated probabilities, proof of fraud, or a basis for denying a transaction, service, or account.</p>
    <h2>Data restrictions</h2><p>Do not enter real banking credentials, payment-card data, account statements, or sensitive customer information. The preview has not been reviewed for that use.</p>
    <h2>Availability</h2><p>The preview is provided for product evaluation and may change. It does not accept payments or provide a paid subscription.</p>
    <h2>Production readiness</h2><p>Any live deployment needs independent security and legal review, production storage and operations, appropriate privacy notices, and a verified data-source agreement before processing real financial data.</p>
    <h2>Questions</h2><p>For product questions, use the contact information on the <a href="/contact">contact page</a> when configured.</p>
  </article></SiteFrame>;
}
