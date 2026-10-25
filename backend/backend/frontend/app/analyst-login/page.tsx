"use client";

import { useState, type FormEvent } from "react";
import { Activity, ArrowRight, Fingerprint, LockKeyhole, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = typeof result.detail === "string" ? result.detail : "Sign-in could not be completed.";
        throw new Error(message);
      }
      const requestedNext = new URLSearchParams(window.location.search).get("next") || "/terminal";
      const destination = new URL(requestedNext, window.location.origin);
      const nextPath = destination.origin === window.location.origin && (destination.pathname === "/terminal" || destination.pathname.startsWith("/terminal/"))
        ? `${destination.pathname}${destination.search}${destination.hash}`
        : "/terminal";
      window.location.assign(nextPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in could not be completed. Try again shortly.");
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell relative flex min-h-dvh flex-col px-5 text-slate-200 sm:px-8 lg:px-12">
      <div aria-hidden="true" className="login-ambient pointer-events-none absolute inset-0" />
      <header className="relative z-10 mx-auto flex w-full max-w-[1380px] items-center justify-between border-b border-white/[.07] py-5">
        <a href="/" aria-label="Fin Sentinels home" className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-200/20 bg-cyan-200/[.07] text-cyan-100"><ShieldCheck size={20} /></span>
          <span><span className="block text-xs font-bold text-slate-100">Fin Sentinels</span><span className="mt-1 block text-xs text-slate-400">Network intelligence</span></span>
        </a>
        <div className="hidden items-center gap-6 text-xs font-medium text-slate-300 sm:flex">
          <a href="/#how-it-works" className="transition hover:text-white">Platform</a>
          <a href="/#security" className="transition hover:text-white">Security</a>
          <a href="/login" className="transition hover:text-white">Customer sign in</a>
          <a href="#workspace" className="rounded-md border border-cyan-200/25 bg-cyan-200/[.07] px-3 py-2 text-cyan-100 transition hover:bg-cyan-200/[.13]">Analyst sign in</a>
        </div>
      </header>

      <div className="relative z-10 mx-auto grid w-full max-w-[1380px] flex-1 items-center gap-12 py-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(370px,.72fr)] lg:gap-20 lg:py-12">
        <section id="capabilities" className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200/20 bg-cyan-200/[.06] px-3 py-2 text-xs font-medium text-cyan-100"><Activity size={14} className="text-cyan-200" /> Network-level financial intelligence</div>
          <h1 className="mt-6 max-w-[700px] text-[clamp(2.5rem,5vw,4.8rem)] font-semibold leading-[1.02] tracking-[-.055em] text-slate-50">See the network behind the transaction.</h1>
          <p className="mt-5 max-w-[570px] text-base leading-7 text-slate-300">Connect account activity, devices, IP addresses and observed relationships in one clear investigation workspace.</p>

          <div className="relative mt-8 max-w-[680px] overflow-hidden rounded-2xl border border-white/[.12] bg-[#0b111b] p-4 shadow-[0_24px_64px_rgba(0,0,0,.3)] sm:p-6">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_52%_50%,rgba(34,211,238,.09),transparent_55%)]" />
            <div className="relative flex items-center justify-between gap-3 text-xs font-medium text-slate-300"><span>Illustrative relationship model</span><span>Analyst view</span></div>
            <svg viewBox="0 0 680 235" role="img" aria-label="Illustration of connected financial entities" className="relative mt-2 h-[180px] w-full sm:h-[220px]">
              <defs>
                <linearGradient id="link" x1="0" x2="1"><stop stopColor="#06B6D4" stopOpacity=".12"/><stop offset=".52" stopColor="#67E8F9" stopOpacity=".68"/><stop offset="1" stopColor="#06B6D4" stopOpacity=".14"/></linearGradient>
                <radialGradient id="hub"><stop stopColor="#67E8F9" stopOpacity=".28"/><stop offset="1" stopColor="#67E8F9" stopOpacity="0"/></radialGradient>
              </defs>
              <g fill="none" stroke="url(#link)" strokeWidth="1.15">
                <path d="M78 132 195 72 322 112 466 52 601 120"/><path d="M78 132 214 183 322 112 446 184 601 120"/><path d="M195 72 214 183M466 52 446 184M322 112 355 34M322 112 346 213"/>
                <path d="M78 132Q210 36 355 34T601 120M78 132Q226 228 346 213T601 120" strokeDasharray="3 7" opacity=".55"/>
              </g>
              <circle cx="322" cy="112" r="56" fill="url(#hub)" />
              <g fill="#0c1822" stroke="#67e8f9" strokeWidth="1.5">
                <circle cx="78" cy="132" r="8"/><circle cx="195" cy="72" r="6"/><circle cx="214" cy="183" r="6"/><circle cx="322" cy="112" r="11"/><circle cx="355" cy="34" r="5"/><circle cx="346" cy="213" r="5"/><circle cx="466" cy="52" r="7"/><circle cx="446" cy="184" r="6"/><circle cx="601" cy="120" r="8"/>
              </g>
              <g fill="#b7f5f4"><circle cx="322" cy="112" r="3.2"/><circle cx="78" cy="132" r="2"/><circle cx="466" cy="52" r="1.8"/><circle cx="601" cy="120" r="2"/></g>
              <g fill="#9aabba" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="12"><text x="45" y="157">Account</text><text x="165" y="52">Device</text><text x="436" y="30">IP address</text><text x="559" y="145">Counterparty</text></g>
            </svg>
            <div className="relative grid grid-cols-1 gap-2 border-t border-white/[.1] pt-4 text-xs text-slate-300 sm:grid-cols-3"><span className="flex items-center gap-2"><i className="h-2 w-2 shrink-0 rounded-full bg-cyan-300"/> Observed relationships</span><span className="flex items-center gap-2"><i className="h-2 w-2 shrink-0 rounded-full bg-amber-300"/> Investigation context</span><span className="flex items-center gap-2"><i className="h-2 w-2 shrink-0 rounded-full bg-rose-400"/> Explainable risk</span></div>
          </div>

          <div id="security" className="mt-6 flex items-center gap-3 text-xs text-slate-300"><Fingerprint size={16} className="shrink-0 text-cyan-200" /><span>Private analyst workspace <span className="mx-1.5 text-slate-500">·</span> Session protected by secure sign-in</span></div>
        </section>

        <section id="workspace" className="relative mx-auto w-full max-w-[460px] lg:ml-auto">
          <div className="absolute -inset-5 rounded-[28px] bg-cyan-300/[.035] blur-2xl" aria-hidden="true" />
          <div className="glass-panel relative rounded-2xl p-6 sm:p-8">
            <div className="flex items-center justify-between gap-3"><div className="text-xs font-semibold text-cyan-100">Analyst access</div><span className="rounded-full border border-white/[.12] px-2.5 py-1 text-xs text-slate-300">Secure workspace</span></div>
            <h2 className="mt-4 text-2xl font-semibold tracking-[-.035em] text-white">Welcome back</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">Sign in with your analyst credentials to continue.</p>

            <form onSubmit={signIn} className="mt-7 space-y-4">
              <label className="block space-y-2 text-sm font-medium text-slate-200">Username
                <input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className="mt-1 h-12 w-full rounded-lg border border-white/[.16] bg-[#080c12] px-3.5 text-sm text-white outline-none transition placeholder:text-slate-400 focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15" placeholder="Your analyst username" />
              </label>
              <label className="block space-y-2 text-sm font-medium text-slate-200">Password
                <span className="relative mt-1 block"><LockKeyhole size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"/><input autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-12 w-full rounded-lg border border-white/[.16] bg-[#080c12] pl-10 pr-3.5 text-sm text-white outline-none transition placeholder:text-slate-400 focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15" placeholder="Enter your password" /></span>
              </label>
              {error && <div role="alert" className="rounded-md border border-rose-300/30 bg-rose-300/[.08] px-3 py-2.5 text-sm leading-relaxed text-rose-100">{error}</div>}
              <button disabled={submitting} className="group mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-cyan-300 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-60">{submitting ? "Verifying access…" : <>Sign in <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5"/></>}</button>
            </form>

            <div className="mt-6 flex items-center gap-2 border-t border-white/[.1] pt-4 text-xs leading-relaxed text-slate-300"><i className="h-2 w-2 shrink-0 rounded-full bg-emerald-300"/> Protected analyst session · Sign in to view your workspace</div>
          </div>
          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400"><ShieldCheck size={14}/> Fin Sentinels network intelligence</div>
        </section>
      </div>

      <footer className="relative z-10 mx-auto flex w-full max-w-[1380px] items-center justify-between gap-4 border-t border-white/[.1] py-4 text-xs text-slate-400"><span>Fin Sentinels · Analyst workspace</span><span>Network intelligence</span></footer>
    </main>
  );
}
