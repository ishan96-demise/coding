import type { Metadata } from "next";
import { CustomerIntelligence } from "@/components/customer-intelligence";

export const metadata: Metadata = { title: "Network & signals | Fin Sentinels", description: "Review the account network and transparent activity signals scoped to your linked accounts." };

export default function CustomerIntelligencePage() { return <CustomerIntelligence />; }
