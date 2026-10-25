import type { Metadata } from "next";
import { CustomerTransactions } from "@/components/customer-transactions";

export const metadata: Metadata = { title: "Transactions | Fin Sentinels", description: "Search, filter, and export the transactions linked to your sample accounts." };

export default function TransactionsPage() { return <CustomerTransactions />; }
