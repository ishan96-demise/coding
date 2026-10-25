import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const incoming = new URL(request.url);
  const backend = (process.env.FIN_API_INTERNAL_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
  const target = `${backend}/api/${path.map(encodeURIComponent).join("/")}${incoming.search}`;
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!["host", "connection", "content-length", "cookie", "accept-encoding", "transfer-encoding"].includes(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  if (path[0] === "portal") {
    const customerSession = request.cookies.get("fin_customer_session")?.value;
    if (customerSession) headers.set("cookie", `fin_customer_session=${customerSession}`);
  }
  const backendKey = process.env.FIN_SENTINELS_BACKEND_API_KEY?.trim();
  if (backendKey) headers.set("x-fin-sentinels-backend-key", backendKey);

  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const header of ["content-length", "content-encoding", "transfer-encoding", "connection", "access-control-allow-origin", "access-control-allow-credentials"]) responseHeaders.delete(header);
    responseHeaders.set("Cache-Control", "no-store");
    if (responseHeaders.get("content-type")?.includes("text/event-stream")) {
      responseHeaders.set("X-Accel-Buffering", "no");
      responseHeaders.set("Cache-Control", "no-cache, no-transform");
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch {
    return Response.json({ detail: "FastAPI is unavailable. Start the backend at 127.0.0.1:8000 and retry." }, { status: 502 });
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
