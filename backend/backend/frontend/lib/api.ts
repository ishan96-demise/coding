import type { IntelligenceSnapshot, Transaction } from "@/lib/types";

export function apiUrl(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

export async function fetchIntelligence(signal?: AbortSignal): Promise<IntelligenceSnapshot> {
  const response = await fetch(apiUrl("/api/intelligence"), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Intelligence API returned ${response.status}`);
  return response.json();
}

export async function fetchRecentTransactions(limit = 80, signal?: AbortSignal): Promise<Transaction[]> {
  const response = await fetch(apiUrl(`/api/transactions/recent?limit=${limit}`), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Transaction API returned ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.transactions) ? data.transactions : [];
}
