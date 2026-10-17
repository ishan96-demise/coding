import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  isLocalAuthConfigured,
  readSessionToken,
} from "@/lib/auth-session";

type RouteContext = { params: Promise<{ caseId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (!isLocalAuthConfigured()) {
    return NextResponse.json({ detail: "Sign-in is not configured." }, { status: 503 });
  }

  const session = await readSessionToken(
    request.cookies.get(AUTH_COOKIE_NAME)?.value,
    process.env.FIN_SENTINELS_SESSION_SECRET,
  );
  if (!session) {
    return NextResponse.json({ detail: "Authentication required." }, { status: 401 });
  }

  const { caseId } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(caseId)) {
    return NextResponse.json({ detail: "Invalid case ID." }, { status: 400 });
  }

  const backendBase = (process.env.FIN_API_INTERNAL_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
  const publicBackendBase = (process.env.FIN_API_PUBLIC_URL || "").replace(/\/$/, "");
  const backendKey = process.env.FIN_SENTINELS_BACKEND_API_KEY?.trim();
  const uploadSecret = process.env.FIN_SENTINELS_UPLOAD_SECRET || "";
  if (!publicBackendBase || !backendKey || backendKey.length < 32 || uploadSecret.length < 32) {
    return NextResponse.json({ detail: "Direct evidence uploads are not configured." }, { status: 503 });
  }

  try {
    const publicUrl = new URL(publicBackendBase);
    if (publicUrl.protocol !== "https:" && publicUrl.hostname !== "localhost" && publicUrl.hostname !== "127.0.0.1") {
      return NextResponse.json({ detail: "The evidence API must use HTTPS." }, { status: 503 });
    }

    const caseResponse = await fetch(`${backendBase}/api/cases/${encodeURIComponent(caseId)}`, {
      headers: { "x-fin-sentinels-backend-key": backendKey },
      cache: "no-store",
    });
    if (!caseResponse.ok) {
      return NextResponse.json({ detail: caseResponse.status === 404 ? "Case not found." : "The case API is unavailable." }, { status: caseResponse.status === 404 ? 404 : 502 });
    }

    const payload = Buffer.from(JSON.stringify({
      case_id: caseId,
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: "case-evidence-upload",
      sub: session.username,
    })).toString("base64url");
    const signature = createHmac("sha256", uploadSecret).update(payload).digest("base64url");
    return NextResponse.json({
      token: `${payload}.${signature}`,
      upload_url: `${publicUrl.origin}/api/cases/${encodeURIComponent(caseId)}/evidence/upload`,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ detail: "The evidence API is unavailable." }, { status: 502 });
  }
}
