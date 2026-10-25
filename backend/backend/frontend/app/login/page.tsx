import type { Metadata } from "next";
import Link from "next/link";
import { CustomerAuthForm } from "@/components/customer-auth-form";
import { SiteFrame } from "@/components/site-chrome";

export const metadata: Metadata = { title: "Log in | Fin Sentinels", description: "Log in to your Fin Sentinels customer workspace." };

export default function CustomerLoginPage() {
  return <SiteFrame workspace="customer"><section className="site-container auth-layout"><div className="auth-side-copy"><p className="eyebrow">Customer portal sign in</p><h2>Pick up where you left off.</h2><p>Log in with the customer account you created to see your linked sample accounts, transactions, network, and reported cases.</p><Link className="text-link" href="/analyst-login?next=%2Fterminal">Analyst sign in <span aria-hidden="true">→</span></Link></div><CustomerAuthForm mode="login" /></section></SiteFrame>;
}
