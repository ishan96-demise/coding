export const AUTH_COOKIE_NAME = "fin_sentinels_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function isLocalAuthConfigured() {
  return Boolean(
    process.env.FIN_SENTINELS_USERNAME?.trim() &&
    process.env.FIN_SENTINELS_PASSWORD &&
    (process.env.FIN_SENTINELS_SESSION_SECRET?.length ?? 0) >= 32,
  );
}

export async function createSessionToken(username: string, secret: string) {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({ sub: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })));
  const key = await signingKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function readSessionToken(token: string | undefined, secret: string | undefined) {
  if (!token || !secret || secret.length < 32) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  try {
    const key = await signingKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, decodeBase64Url(signature), encoder.encode(payload));
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as { sub?: unknown; exp?: unknown };
    if (typeof data.sub !== "string" || typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return { username: data.sub, expiresAt: data.exp };
  } catch {
    return null;
  }
}
