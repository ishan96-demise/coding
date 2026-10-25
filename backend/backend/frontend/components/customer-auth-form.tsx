"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";

export function CustomerAuthForm({ mode }: { mode: "login" | "signup" }) {
  const signup = mode === "signup";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (signup && name.trim().length < 2) return setError("Enter your name so we can personalize your workspace.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Enter a valid email address.");
    if (signup && password.length < 10) return setError("Use at least 10 characters for your password.");
    if (!signup && !password) return setError("Enter your password to continue.");

    setBusy(true);
    try {
      const response = await fetch(`/api/portal/${signup ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), password }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "We could not complete your request.");
      const requestedNext = new URLSearchParams(window.location.search).get("next") || "";
      const destination = requestedNext ? new URL(requestedNext, window.location.origin) : new URL("/dashboard", window.location.origin);
      const nextPath = destination.origin === window.location.origin && (destination.pathname === "/dashboard" || destination.pathname.startsWith("/dashboard/"))
        ? `${destination.pathname}${destination.search}${destination.hash}`
        : "/dashboard";
      window.location.assign(nextPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We could not reach the service. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="auth-card">
      <div className="auth-card-brand"><span className="brand-icon"><ShieldCheck size={20} /></span><span>Customer workspace</span></div>
      <h1>{signup ? "Create your customer account" : "Customer sign in"}</h1>
      <p className="auth-intro">{signup ? "Set up a private workspace to review your sample account activity." : "Sign in to view your linked accounts and transaction activity."}</p>
      <form onSubmit={submit} className="auth-form" noValidate>
        {signup && <label>Your name<input autoComplete="name" name="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="Alex Morgan" /></label>}
        <label>Email address<input autoComplete="email" name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required placeholder="you@example.com" /></label>
        <label>Password<input autoComplete={signup ? "new-password" : "current-password"} name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={signup ? 10 : 1} required placeholder={signup ? "At least 10 characters" : "Your password"} /></label>
        {signup && <p className="form-hint">Use at least 10 characters. This demo links two synthetic accounts to your workspace.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? <><LoaderCircle size={17} className="spin" /> {signup ? "Creating account…" : "Signing in…"}</> : <>{signup ? "Create account" : "Log in"}<ArrowRight size={17} /></>}</button>
      </form>
      <p className="auth-switch">
        {signup ? "Already have an account?" : "New to Fin Sentinels?"}{" "}
        <Link href={signup ? "/login" : "/signup"} onClick={(event) => {
          const requestedNext = new URLSearchParams(window.location.search).get("next");
          if (!requestedNext) return;
          event.preventDefault();
          window.location.assign(authHref(signup ? "/login" : "/signup"));
        }}>{signup ? "Log in" : "Create an account"}</Link>
      </p>
      <p className="auth-footnote">Demo workspace only. Do not enter real banking credentials or sensitive financial information.</p>
    </div>
  );
}

function authHref(path: "/login" | "/signup") {
  if (typeof window === "undefined") return path;
  const requestedNext = new URLSearchParams(window.location.search).get("next");
  if (!requestedNext) return path;
  const destination = new URL(requestedNext, window.location.origin);
  if (destination.origin !== window.location.origin || !(destination.pathname === "/dashboard" || destination.pathname.startsWith("/dashboard/"))) return path;
  return `${path}?next=${encodeURIComponent(`${destination.pathname}${destination.search}${destination.hash}`)}`;
}
