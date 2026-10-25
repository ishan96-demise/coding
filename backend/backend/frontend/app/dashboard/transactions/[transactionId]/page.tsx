import type { Metadata } from "next";
import { CustomerTransactionDetail } from "@/components/customer-transaction-detail";

export const metadata: Metadata = { title: "Transaction details | Fin Sentinels", description: "Review a transaction and report it to the sample case queue." };

export default function TransactionDetailPage() { return <CustomerTransactionDetail />; }
