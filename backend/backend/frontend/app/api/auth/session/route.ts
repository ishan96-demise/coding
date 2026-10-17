import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isLocalAuthConfigured, readSessionToken } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  if (!isLocalAuthConfigured()) return NextResponse.json({ authenticated: false, configured: false }, { status: 200 });
  const session = await readSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, process.env.FIN_SENTINELS_SESSION_SECRET);
  return NextResponse.json(session ? { authenticated: true, username: session.username } : { authenticated: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
