import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth-session";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.set(AUTH_COOKIE_NAME, "", { httpOnly: true, secure: request.nextUrl.protocol === "https:" || process.env.FIN_SENTINELS_COOKIE_SECURE === "true", sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
