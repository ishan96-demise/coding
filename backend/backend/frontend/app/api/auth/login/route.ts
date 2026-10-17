import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, createSessionToken, isLocalAuthConfigured, SESSION_TTL_SECONDS } from "@/lib/auth-session";

export const runtime = "nodejs";

function secureEquals(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function POST(request: NextRequest) {
  if (!isLocalAuthConfigured()) {
    return NextResponse.json({ detail: "Sign-in is temporarily unavailable. Contact your workspace administrator." }, { status: 503 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: "Enter your username and password." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const configuredUsername = process.env.FIN_SENTINELS_USERNAME!.trim();
  const configuredPassword = process.env.FIN_SENTINELS_PASSWORD!;
  if (!secureEquals(username, configuredUsername) || !secureEquals(password, configuredPassword)) {
    return NextResponse.json({ detail: "Username or password is incorrect." }, { status: 401 });
  }

  const token = await createSessionToken(configuredUsername, process.env.FIN_SENTINELS_SESSION_SECRET!);
  const response = NextResponse.json({ success: true, username: configuredUsername });
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:" || process.env.FIN_SENTINELS_COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
