import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isLocalAuthConfigured, readSessionToken } from "@/lib/auth-session";

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/public/summary",
  "/api/auth/login",
  "/api/auth/session",
  "/api/auth/logout",
  "/api/integrations/obp/webhook",
]);

function isAnalystApi(pathname: string) {
  if (!pathname.startsWith("/api/")) return false;
  if (PUBLIC_API_PATHS.has(pathname)) return false;
  if (pathname === "/api/portal" || pathname.startsWith("/api/portal/")) return false;
  return true;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAnalystPage = pathname === "/terminal" || pathname.startsWith("/terminal/");
  const isCustomerPage = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const protectedApi = isAnalystApi(pathname);
  if (isCustomerPage) {
    if (request.cookies.get("fin_customer_session")?.value) return NextResponse.next();
    const next = `${pathname}${request.nextUrl.search}`;
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, request.url));
  }
  if (!isAnalystPage && !protectedApi) return NextResponse.next();

  if (!isLocalAuthConfigured()) {
    if (protectedApi) {
      return NextResponse.json({ detail: "Sign-in is temporarily unavailable. Contact your workspace administrator." }, { status: 503 });
    }
    const next = `${pathname}${request.nextUrl.search}`;
    return NextResponse.redirect(new URL(`/analyst-login?next=${encodeURIComponent(next)}`, request.url));
  }

  const session = await readSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, process.env.FIN_SENTINELS_SESSION_SECRET);
  if (session) return NextResponse.next();

  if (protectedApi) return NextResponse.json({ detail: "Authentication required." }, { status: 401 });
  const next = `${pathname}${request.nextUrl.search}`;
  return NextResponse.redirect(new URL(`/analyst-login?next=${encodeURIComponent(next)}`, request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
