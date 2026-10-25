import type { Metadata } from "next";
import Link from "next/link";
import { CustomerAuthForm } from "@/components/customer-auth-form";
import { SiteFrame } from "@/components/site-chrome";

export const metadata: Metadata = { title: "Create an account | Fin Sentinels", description: "Create a customer workspace with two synthetic accounts." };

export default function SignupPage() {
  return <SiteFrame workspace="customer"><section className="site-container auth-layout"><div className="auth-side-copy"><p className="eyebrow">Create a customer account</p><h2>Your activity, in one clear view.</h2><p>Create a preview account to review synthetic balances, search transaction history, and report a sample transaction.</p><ul><li>Two synthetic accounts linked to your workspace</li><li>Search, filters, and CSV export</li><li>Private, password-protected sign-in</li></ul><Link className="text-link" href="/privacy">How account information is handled <span aria-hidden="true">→</span></Link></div><CustomerAuthForm mode="signup" /></section></SiteFrame>;
}
