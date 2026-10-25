import type { IntelligenceSnapshot, Transaction } from "@/lib/types";

export function apiUrl(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

const API_TIMEOUT_MS = 20_000;

async function fetchApiJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const requestController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, API_TIMEOUT_MS);
  const abortWithCaller = () => requestController.abort(signal?.reason);
  if (signal?.aborted) abortWithCaller();
  else signal?.addEventListener("abort", abortWithCaller, { once: true });

  try {
    const response = await fetch(apiUrl(path), { signal: requestController.signal, cache: "no-store" });
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    if (!response.ok) {
      const detail = typeof body?.detail === "string" ? body.detail : "The API did not return a usable response.";
      if (response.status === 401) {
        throw new Error(`API rejected the request (401): ${detail} Check the analyst sign-in and the matching backend key in both local environment files.`);
      }
      if (response.status === 503) {
        throw new Error(`API is unavailable (503): ${detail} Check the backend configuration and restart the API.`);
      }
      if (response.status === 502) {
        throw new Error(`The web server could not reach FastAPI (502): ${detail}`);
      }
      throw new Error(`API request failed (${response.status}): ${detail}`);
    }
    return body as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new Error(`The API did not respond within ${API_TIMEOUT_MS / 1000} seconds. Confirm FastAPI is running on 127.0.0.1:8000, then retry.`);
    if (error instanceof TypeError) throw new Error("The browser could not reach the web server's API proxy. Restart the frontend and FastAPI, then retry.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortWithCaller);
  }
}

export async function fetchIntelligence(signal?: AbortSignal): Promise<IntelligenceSnapshot> {
  return fetchApiJson<IntelligenceSnapshot>("/api/intelligence", signal);
}

export async function fetchRecentTransactions(limit = 80, signal?: AbortSignal): Promise<Transaction[]> {
  const data = await fetchApiJson<{ transactions?: unknown }>(`/api/transactions/recent?limit=${limit}`, signal);
  return Array.isArray(data.transactions) ? data.transactions : [];
}
