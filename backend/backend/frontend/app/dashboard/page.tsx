import type { Metadata } from "next";
import { CustomerDashboard } from "@/components/customer-dashboard";

export const metadata: Metadata = { title: "Overview | Fin Sentinels", description: "Review the accounts and sample transactions linked to your Fin Sentinels workspace." };

export default function DashboardPage() { return <CustomerDashboard />; }
