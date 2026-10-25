import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Eye, ShieldCheck, UsersRound } from "lucide-react";
import { SiteFrame } from "@/components/site-chrome";

export const metadata: Metadata = { title: "About | Fin Sentinels", description: "Learn why Fin Sentinels focuses on connected transaction context and human-led review." };

export default function AboutPage() {
  return <SiteFrame active="about"><section className="site-container page-hero"><p className="eyebrow">About Fin Sentinels</p><h1>Financial activity makes more sense in context.</h1><p>We are building a review workspace that helps people connect transaction activity to the relationships around it—clearly, carefully, and with evidence close at hand.</p></section>
    <section className="site-container about-grid"><article><div className="step-icon"><Eye size={20}/></div><h2>Clarity before complexity</h2><p>Move from an account or transaction to related activity without losing sight of the underlying records.</p></article><article><div className="step-icon"><UsersRound size={20}/></div><h2>People stay responsible</h2><p>Signals are there to support investigation. A score is not a verdict, and the system does not make customer decisions automatically.</p></article><article><div className="step-icon"><ShieldCheck size={20}/></div><h2>Honest about what is ready</h2><p>This build is an early preview using synthetic data. Production-grade data handling and external bank connections require more work.</p></article></section>
    <section className="site-container about-callout"><div><p className="eyebrow">The current preview</p><h2>Explore a sample workspace.</h2><p>Sign up to see two synthetic accounts, searchable activity, and a transaction-report flow.</p></div><Link className="button button-primary" href="/signup">Create an account <ArrowRight size={16}/></Link></section></SiteFrame>;
}
