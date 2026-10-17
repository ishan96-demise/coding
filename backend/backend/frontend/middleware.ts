import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isLocalAuthConfigured, readSessionToken } from "@/lib/auth-session";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/session", "/api/auth/logout", "/api/integrations/obp/webhook"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (!isLocalAuthConfigured()) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ detail: "Sign-in is temporarily unavailable. Contact your workspace administrator." }, { status: 503 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const session = await readSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, process.env.FIN_SENTINELS_SESSION_SECRET);
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ detail: "Authentication required." }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
