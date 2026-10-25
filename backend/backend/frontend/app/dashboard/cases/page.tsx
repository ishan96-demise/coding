import type { Metadata } from "next";
import { CustomerCases } from "@/components/customer-cases";

export const metadata: Metadata = { title: "My cases | Fin Sentinels", description: "Track the transactions you reported for analyst review." };

export default function CustomerCasesPage() { return <CustomerCases />; }
