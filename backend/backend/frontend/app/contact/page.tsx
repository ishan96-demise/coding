import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { SiteFrame } from "@/components/site-chrome";

export const metadata: Metadata = { title: "Contact | Fin Sentinels", description: "Contact Fin Sentinels about the product preview and pilot scope." };

export default function ContactPage() {
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  return <SiteFrame><section className="site-container page-hero"><p className="eyebrow">Contact</p><h1>Let’s talk about the problem you’re solving.</h1><p>Tell us what your review team needs to understand about account activity and connected transactions.</p></section>
    <section className="site-container contact-layout"><article className="contact-card"><span className="step-icon"><Mail size={20}/></span><h2>Product and pilot enquiries</h2><p>{contactEmail ? "Email the Fin Sentinels team and tell us a little about your use case." : "A direct contact address has not been configured for this preview yet."}</p>{contactEmail ? <a className="button button-primary" href={`mailto:${contactEmail}`}>Email the team <ArrowRight size={16}/></a> : <p className="form-hint">Set NEXT_PUBLIC_CONTACT_EMAIL in the frontend deployment environment to publish a contact address.</p>}</article><article className="contact-note"><p className="eyebrow">Please note</p><h2>Keep sensitive data out of the conversation.</h2><p>This preview is not approved for real customer or banking data. Do not email account numbers, transaction statements, credentials, or personal financial information.</p><Link className="text-link" href="/privacy">Read the privacy notes <ArrowRight size={15}/></Link></article></section></SiteFrame>;
}
