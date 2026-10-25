"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowUpRight, BriefcaseBusiness, Check, ChevronUp, FileText, LoaderCircle, Paperclip, Plus, RefreshCw, Search, X } from "lucide-react";
import { apiUrl } from "@/lib/api";

type InvestigationCase = {
  case_id: string;
  account_id: string;
  priority?: string;
  status?: string;
  risk_score?: number;
  risk_status?: string;
  note?: string;
  created_at?: string;
};

type CreateCaseResponse = InvestigationCase & { success?: boolean; existing?: boolean; message?: string };
type EvidenceRecord = { evidence_id: string; evidence_type?: string; description?: string; transaction_ids?: string[]; timestamp?: string; file_name?: string; file_url?: string; file_size?: number };
type DetailedCase = InvestigationCase & { evidence?: EvidenceRecord[]; timeline?: { title?: string; description?: string; timestamp?: string }[] };

export function CaseQueue({ onAnalyze, selectedAccount }: { onAnalyze: (account: string) => void; selectedAccount: string }) {
  const [cases, setCases] = useState<InvestigationCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [notice, setNotice] = useState("");
  const [accountId, setAccountId] = useState(selectedAccount);
  const [priority, setPriority] = useState("HIGH");
  const [caseNote, setCaseNote] = useState("");
  const [evidenceType, setEvidenceType] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [transactionIds, setTransactionIds] = useState("");
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [pendingCaseId, setPendingCaseId] = useState("");
  const [textEvidenceSaved, setTextEvidenceSaved] = useState(false);
  const [uploadedFileKeys, setUploadedFileKeys] = useState<string[]>([]);
  const [selectedCase, setSelectedCase] = useState<DetailedCase | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [queueSearch, setQueueSearch] = useState("");
  const [queueFilter, setQueueFilter] = useState<"ALL" | "ACTIVE" | "CLOSED" | "DISMISSED">("ALL");
  const [savingCaseId, setSavingCaseId] = useState("");
  const [queueActionError, setQueueActionError] = useState("");

  const loadCases = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(apiUrl("/api/cases"), { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Case API returned ${response.status}`);
    const data = await response.json();
    setCases(Array.isArray(data.cases) ? data.cases : []);
    setError("");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadCases(controller.signal)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Case queue unavailable");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadCases]);

  useEffect(() => {
    setAccountId(selectedAccount);
  }, [selectedAccount]);

  const active = cases.filter((item) => !["CLOSED", "DISMISSED"].includes((item.status || "").toUpperCase())).length;
  const high = cases.filter((item) => (item.risk_status || "").toUpperCase() === "HIGH RISK").length;
  const normalizedSearch = queueSearch.trim().toLowerCase();
  const visibleCases = cases.filter((item) => {
    const status = (item.status || "OPEN").toUpperCase();
    const matchesFilter = queueFilter === "ALL"
      || (queueFilter === "ACTIVE" && !["CLOSED", "DISMISSED"].includes(status))
      || status === queueFilter;
    const searchable = [item.case_id, item.account_id, item.priority, item.status, item.risk_status, item.note]
      .filter(Boolean).join(" ").toLowerCase();
    return matchesFilter && (!normalizedSearch || searchable.includes(normalizedSearch));
  });

  const updateCase = async (item: InvestigationCase, field: "status" | "priority", value: string) => {
    setSavingCaseId(item.case_id);
    setQueueActionError("");
    try {
      const response = await fetch(apiUrl(`/api/cases/${encodeURIComponent(item.case_id)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : `Case update failed (${response.status})`);
      const updated = payload as DetailedCase;
      setCases((current) => current.map((entry) => entry.case_id === item.case_id ? updated : entry));
      setSelectedCase((current) => current?.case_id === item.case_id ? updated : current);
      setNotice(`${item.case_id} ${field} updated.`);
    } catch (reason) {
      setQueueActionError(reason instanceof Error ? reason.message : "Unable to update the case.");
      await loadCases().catch(() => undefined);
    } finally {
      setSavingCaseId("");
    }
  };

  const openCaseDetails = async (item: InvestigationCase) => {
    setSelectedCase(item);
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch(apiUrl(`/api/cases/${encodeURIComponent(item.case_id)}`), { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : `Case detail request failed (${response.status})`);
      setSelectedCase(payload as DetailedCase);
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : "Unable to load case evidence.");
    } finally {
      setDetailLoading(false);
    }
  };

  const createInvestigation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedIds = transactionIds.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean);
    const hasTextEvidence = Boolean(evidenceDescription.trim() || normalizedIds.length);
    if (!hasTextEvidence && !evidenceFiles.length) {
      setSubmitError("Add evidence details, transaction IDs, or at least one evidence file.");
      return;
    }
    if (evidenceFiles.some((file) => file.size > 10 * 1024 * 1024 || !/\.(pdf|png|jpe?g)$/i.test(file.name))) {
      setSubmitError("Evidence must be PDF, PNG, or JPG files no larger than 10 MB each.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    setNotice("");
    let createdCase: CreateCaseResponse;
    if (pendingCaseId) {
      createdCase = { case_id: pendingCaseId, account_id: accountId, existing: true };
    } else {
      try {
        const response = await fetch(apiUrl("/api/cases"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: accountId.trim(), priority, note: caseNote.trim() }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : `Case creation failed (${response.status})`);
        createdCase = payload as CreateCaseResponse;
        if (!createdCase.case_id) throw new Error("The API did not return a case ID.");
        setPendingCaseId(createdCase.case_id);
      } catch (reason) {
        setSubmitError(reason instanceof Error ? reason.message : "Unable to create the investigation.");
        setSubmitting(false);
        return;
      }
    }

    try {
      if (hasTextEvidence && !textEvidenceSaved) {
        const response = await fetch(apiUrl(`/api/cases/${encodeURIComponent(createdCase.case_id)}/evidence`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evidence_type: evidenceType.trim(), description: evidenceDescription.trim(), transaction_ids: normalizedIds }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : `Evidence attachment failed (${response.status})`);
        setTextEvidenceSaved(true);
      }
      const completedFiles = new Set(uploadedFileKeys);
      for (const evidenceFile of evidenceFiles) {
        const fileKey = `${evidenceFile.name}:${evidenceFile.size}:${evidenceFile.lastModified}`;
        if (completedFiles.has(fileKey)) continue;
        const upload = new FormData();
        upload.append("file", evidenceFile, evidenceFile.name);
        upload.append("evidence_type", evidenceType.trim());
        upload.append("description", evidenceDescription.trim());
        const response = await fetch(apiUrl(`/api/cases/${encodeURIComponent(createdCase.case_id)}/evidence/upload`), { method: "POST", body: upload });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`${evidenceFile.name}: ${typeof payload.detail === "string" ? payload.detail : `upload failed (${response.status})`}`);
        completedFiles.add(fileKey);
        setUploadedFileKeys((current) => current.includes(fileKey) ? current : [...current, fileKey]);
      }
    } catch (reason) {
      setSubmitError(`Case ${createdCase.case_id} was created, but some evidence did not save: ${reason instanceof Error ? reason.message : "request failed"}. The case is in the queue; retry to attach any missing evidence.`);
      await loadCases().catch(() => undefined);
      setSubmitting(false);
      return;
    }

    await loadCases().catch(() => undefined);
    setNotice(`${createdCase.existing ? "Existing active investigation updated" : "Investigation created"}: ${createdCase.case_id}`);
    setCaseNote("");
    setEvidenceType("");
    setEvidenceDescription("");
    setTransactionIds("");
    setEvidenceFiles([]);
    setPendingCaseId("");
    setTextEvidenceSaved(false);
    setUploadedFileKeys([]);
    setFormOpen(false);
    setSubmitting(false);
  };

  return <div className="space-y-3">
    <section className="panel-glow overflow-hidden rounded-lg border border-cyan-300/[.12] bg-[#0d121b]/95">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5"><BriefcaseBusiness size={15} className="shrink-0 text-cyan-200"/><div><div className="text-[10px] font-bold tracking-[.14em] text-slate-300">START AN INVESTIGATION</div><div className="mt-1 text-[9px] text-slate-600">Create a case for an account and attach analyst evidence or transaction references.</div></div></div>
        <button type="button" aria-expanded={formOpen} onClick={() => { setFormOpen((open) => !open); setSubmitError(""); }} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-cyan-300/20 bg-cyan-300/[.07] px-3 text-[9px] font-semibold tracking-wider text-cyan-100 transition hover:bg-cyan-300/[.12]">
          {formOpen ? <ChevronUp size={13}/> : <Plus size={13}/>} {formOpen ? "CLOSE FORM" : "CREATE INVESTIGATION"}
        </button>
      </div>
      {formOpen && <form onSubmit={createInvestigation} className="grid grid-cols-1 gap-3 border-t border-white/[.06] px-4 py-4 md:grid-cols-2 xl:grid-cols-3">
        {pendingCaseId && <div role="status" className="rounded border border-amber-300/15 bg-amber-300/[.035] px-3 py-2 text-[9px] text-amber-100 md:col-span-2 xl:col-span-3">Case {pendingCaseId} is saved. Finish attaching the evidence below; already saved items will not be duplicated.</div>}
        <label className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500">ACCOUNT ID
          <input required disabled={Boolean(pendingCaseId)} maxLength={100} value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="Account to investigate" className="h-9 w-full rounded-md border border-white/[.09] bg-[#080c13] px-2.5 font-mono text-[10px] tracking-normal text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-300/40 disabled:opacity-60" />
        </label>
        <label className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500">PRIORITY
          <select disabled={Boolean(pendingCaseId)} value={priority} onChange={(event) => setPriority(event.target.value)} className="h-9 w-full rounded-md border border-white/[.09] bg-[#080c13] px-2.5 text-[10px] tracking-normal text-slate-200 outline-none focus:border-cyan-300/40 disabled:opacity-60">
            <option value="CRITICAL">CRITICAL</option><option value="HIGH">HIGH</option><option value="MEDIUM">MEDIUM</option><option value="LOW">LOW</option>
          </select>
        </label>
        <label className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500 md:col-span-2 xl:col-span-1">CASE NOTE
          <input disabled={Boolean(pendingCaseId)} maxLength={5000} value={caseNote} onChange={(event) => setCaseNote(event.target.value)} placeholder="Investigation context (optional)" className="h-9 w-full rounded-md border border-white/[.09] bg-[#080c13] px-2.5 text-[10px] tracking-normal text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-300/40 disabled:opacity-60" />
        </label>
        <div className="md:col-span-2 xl:col-span-3"><div className="mb-2 text-[8px] font-semibold tracking-[.12em] text-cyan-100/65">INITIAL EVIDENCE</div><div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500">EVIDENCE TYPE
            <input required disabled={Boolean(pendingCaseId)} maxLength={120} value={evidenceType} onChange={(event) => setEvidenceType(event.target.value)} placeholder="e.g. Transaction review" className="h-9 w-full rounded-md border border-white/[.09] bg-[#080c13] px-2.5 text-[10px] tracking-normal text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-300/40 disabled:opacity-60" />
          </label>
          <label className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500 md:col-span-2">EVIDENCE DETAILS
            <textarea required={!evidenceFiles.length && !transactionIds.trim()} disabled={Boolean(pendingCaseId)} maxLength={5000} rows={2} value={evidenceDescription} onChange={(event) => setEvidenceDescription(event.target.value)} placeholder="Describe the observed evidence and its source." className="w-full resize-y rounded-md border border-white/[.09] bg-[#080c13] px-2.5 py-2 text-[10px] leading-relaxed tracking-normal text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-300/40 disabled:opacity-60" />
          </label>
          <label className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500 md:col-span-2 xl:col-span-3">TRANSACTION IDS <span className="font-normal tracking-normal text-slate-700">OPTIONAL · separate with commas or spaces</span>
            <input disabled={Boolean(pendingCaseId)} value={transactionIds} onChange={(event) => setTransactionIds(event.target.value)} placeholder="Add source transaction references" className="h-9 w-full rounded-md border border-white/[.09] bg-[#080c13] px-2.5 font-mono text-[10px] tracking-normal text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-300/40 disabled:opacity-60" />
          </label>
          <div className="space-y-1.5 text-[8px] font-semibold tracking-[.12em] text-slate-500 md:col-span-2 xl:col-span-3"><label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-white/[.12] bg-black/10 px-3 transition hover:border-cyan-300/25 hover:bg-cyan-300/[.025]"><Paperclip size={13} className="text-cyan-200"/><span>ATTACH EVIDENCE FILES</span><span className="ml-auto font-normal tracking-normal text-slate-600">PDF, PNG, JPG · 10 MB max each</span><input className="sr-only" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(event) => { const chosen = Array.from(event.target.files || []); event.target.value = ""; const invalid = chosen.find((file) => file.size > 10 * 1024 * 1024 || !/\.(pdf|png|jpe?g)$/i.test(file.name)); if (invalid) { setSubmitError(`${invalid.name} is not supported or exceeds 10 MB.`); return; } setSubmitError(""); setEvidenceFiles((current) => [...current, ...chosen.filter((file) => !current.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified))]); }} /></label>
            {evidenceFiles.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5">{evidenceFiles.map((file) => { const fileKey = `${file.name}:${file.size}:${file.lastModified}`; const saved = uploadedFileKeys.includes(fileKey); return <li key={fileKey} className="flex max-w-full items-center gap-1.5 rounded border border-white/[.07] bg-white/[.025] px-2 py-1 font-mono text-[8px] tracking-normal text-slate-400"><FileText size={10} className="shrink-0 text-cyan-200/70"/><span className="max-w-[240px] truncate">{file.name}</span><span className="shrink-0 text-slate-600">{(file.size / (1024 * 1024)).toFixed(1)} MB{saved ? " · SAVED" : ""}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setEvidenceFiles((current) => current.filter((item) => item !== file))} className="ml-1 text-slate-600 hover:text-rose-200"><X size={10}/></button></li>; })}</ul>}
          </div>
        </div></div>
        {submitError && <div role="alert" className="flex items-start gap-2 rounded-md border border-rose-300/15 bg-rose-300/[.04] px-3 py-2 text-[9px] leading-relaxed text-rose-200 md:col-span-2 xl:col-span-3"><AlertTriangle size={13} className="mt-0.5 shrink-0"/>{submitError}</div>}
        <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2 xl:col-span-3"><p className="text-[8px] text-slate-600">Account risk is calculated by FastAPI from the current linked graph. Evidence is stored in the case record.</p><button disabled={submitting} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-300 px-3.5 text-[9px] font-bold tracking-wider text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-60">
          {submitting ? <LoaderCircle size={13} className="animate-spin"/> : <Check size={13}/>} {submitting ? "SAVING CASE + EVIDENCE" : "CREATE CASE + SAVE EVIDENCE"}
        </button></div>
      </form>}
      {notice && <div role="status" className="flex items-center gap-2 border-t border-emerald-300/10 bg-emerald-300/[.035] px-4 py-2 text-[9px] text-emerald-200"><Check size={12}/>{notice}</div>}
    </section>

    <section className="panel-glow overflow-hidden rounded-lg border border-white/[.07] bg-[#0d121b]/95">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] px-4 py-3">
        <div className="flex items-center gap-2.5"><BriefcaseBusiness size={15} className="text-cyan-200"/><div><div className="text-[10px] font-bold tracking-[.14em] text-slate-300">INVESTIGATION CASE QUEUE</div><div className="mt-1 text-[9px] text-slate-600">Current risk is recalculated from the linked transaction graph.</div></div></div>
        <div className="flex items-center gap-2"><Summary label="ACTIVE" value={active}/><Summary label="HIGH RISK" value={high} tone="text-rose-300"/><button type="button" aria-label="Refresh cases" onClick={() => { setLoading(true); loadCases().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Case queue unavailable")).finally(() => setLoading(false)); }} className="grid h-8 w-8 place-items-center rounded border border-white/[.08] text-slate-500 transition hover:bg-white/[.04] hover:text-cyan-100"><RefreshCw size={12}/></button></div>
      </div>
      <div className="divide-y divide-white/[.05] xl:hidden">
        {loading && <div className="flex h-40 items-center justify-center gap-2 text-[10px] text-slate-500"><RefreshCw size={12} className="animate-spin"/>Loading cases…</div>}
        {!loading && error && <div className="flex h-40 items-center justify-center gap-2 text-[10px] text-rose-300"><AlertTriangle size={13}/>{error}</div>}
        {!loading && !error && cases.length === 0 && <div className="grid h-40 place-items-center text-[10px] text-slate-600">No cases are currently recorded by the API.</div>}
        {!loading && !error && cases.length > 0 && visibleCases.length === 0 && <div className="grid h-32 place-items-center text-[10px] text-slate-600">No cases match these filters.</div>}
        {!loading && !error && visibleCases.map((item) => {
          const isHigh = (item.risk_status || "").toUpperCase() === "HIGH RISK";
          return <article key={`compact-${item.case_id}`} className="space-y-3 p-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="font-mono text-[8px] tracking-wider text-slate-600">{item.case_id} · {(item.status || "OPEN").replaceAll("_", " ")}</div><button type="button" onClick={() => onAnalyze(item.account_id)} className="mt-1 font-mono text-[11px] text-cyan-100/85 hover:text-cyan-50">{item.account_id}<ArrowUpRight size={10} className="ml-1 inline text-slate-600"/></button></div><div className="text-right"><div className={`font-mono text-[15px] ${isHigh ? "text-rose-300" : "text-slate-300"}`}>{item.risk_score ?? "—"}<span className="ml-1 text-[8px] text-slate-600">/100</span></div><div className={`mt-0.5 text-[7px] font-bold tracking-wider ${isHigh ? "text-rose-300" : "text-slate-500"}`}>{item.risk_status || "UNSCORED"}</div></div></div>
            <p className="line-clamp-2 text-[9px] leading-relaxed text-slate-500">{item.note || "No analyst note"}</p>
            <div className="grid grid-cols-2 gap-2"><label className="space-y-1 text-[7px] font-bold tracking-wider text-slate-600">PRIORITY<select aria-label={`Priority for ${item.case_id}`} value={item.priority || "MEDIUM"} disabled={savingCaseId === item.case_id} onChange={(event) => void updateCase(item, "priority", event.target.value)} className="h-8 w-full rounded border border-white/[.08] bg-[#080c13] px-2 text-[9px] text-slate-300 outline-none focus:border-cyan-300/30 disabled:opacity-50"><option value="CRITICAL">CRITICAL</option><option value="HIGH">HIGH</option><option value="MEDIUM">MEDIUM</option><option value="LOW">LOW</option></select></label><label className="space-y-1 text-[7px] font-bold tracking-wider text-slate-600">WORKFLOW STATUS<select aria-label={`Workflow status for ${item.case_id}`} value={(item.status || "OPEN").toUpperCase()} disabled={savingCaseId === item.case_id} onChange={(event) => void updateCase(item, "status", event.target.value)} className="h-8 w-full rounded border border-white/[.08] bg-[#080c13] px-2 text-[9px] text-slate-300 outline-none focus:border-cyan-300/30 disabled:opacity-50"><option value="OPEN">OPEN</option><option value="INVESTIGATING">INVESTIGATING</option><option value="CLOSED">CLOSED</option><option value="DISMISSED">DISMISSED</option></select></label></div>
            <div className="flex items-center justify-between gap-2"><button type="button" onClick={() => openCaseDetails(item)} className="inline-flex h-8 items-center gap-1.5 rounded border border-white/[.08] px-2.5 text-[8px] font-semibold text-slate-400 hover:border-cyan-300/20 hover:text-cyan-100"><FileText size={11}/>CASE DETAILS</button><button type="button" onClick={() => onAnalyze(item.account_id)} className="inline-flex h-8 items-center gap-1.5 rounded border border-cyan-300/15 bg-cyan-300/[.05] px-2.5 text-[8px] font-semibold text-cyan-100/80 hover:bg-cyan-300/[.1]">OPEN NETWORK<ArrowUpRight size={11}/></button></div>
          </article>;
        })}
      </div>
      <div className="hidden overflow-x-auto xl:block"><div className="min-w-[960px]">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[.05] px-4 py-3">
          <label className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-white/[.08] bg-black/15 px-2.5 text-slate-500 focus-within:border-cyan-300/30">
            <Search size={12}/><input value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)} placeholder="Search case, account, note, or risk…" className="min-w-0 flex-1 bg-transparent text-[9px] text-slate-200 outline-none placeholder:text-slate-700" aria-label="Search cases" />
          </label>
          <div className="flex items-center gap-1 rounded-md border border-white/[.06] p-1" role="group" aria-label="Filter cases by status">
            {(["ALL", "ACTIVE", "CLOSED", "DISMISSED"] as const).map((filter) => <button key={filter} type="button" aria-pressed={queueFilter === filter} onClick={() => setQueueFilter(filter)} className={`h-6 rounded px-2 text-[7px] font-semibold tracking-wider transition ${queueFilter === filter ? "bg-cyan-200/10 text-cyan-100" : "text-slate-600 hover:text-slate-300"}`}>{filter}</button>)}
          </div>
          <span className="ml-auto font-mono text-[8px] text-slate-600">{visibleCases.length} / {cases.length} CASES</span>
        </div>
        {queueActionError && <div role="alert" className="border-b border-rose-300/10 bg-rose-300/[.035] px-4 py-2 text-[9px] text-rose-200">{queueActionError}</div>}
        <div className="grid grid-cols-[100px_110px_120px_140px_minmax(200px,1fr)_70px_140px] gap-3 border-b border-white/[.04] px-4 py-2 text-[8px] font-bold tracking-[.12em] text-slate-700"><span>CASE</span><span>ACCOUNT</span><span>PRIORITY</span><span>WORKFLOW</span><span>RISK / NOTE</span><span className="text-right">SCORE</span><span className="text-right">ACTIONS</span></div>
        <div className="terminal-scroll max-h-[calc(100dvh-300px)] min-h-[260px] overflow-auto">
          {loading && <div className="flex h-48 items-center justify-center gap-2 text-[10px] text-slate-500"><RefreshCw size={12} className="animate-spin"/>Loading current cases and network scores…</div>}
          {!loading && error && <div className="flex h-48 items-center justify-center gap-2 text-[10px] text-rose-300"><AlertTriangle size={13}/>{error}</div>}
          {!loading && !error && cases.length === 0 && <div className="grid h-48 place-items-center text-[10px] text-slate-600">No cases are currently recorded by the API.</div>}
          {!loading && !error && cases.length > 0 && visibleCases.length === 0 && <div className="grid h-40 place-items-center text-[10px] text-slate-600">No cases match these filters.</div>}
          {!loading && !error && visibleCases.map((item) => {
            const isHigh = (item.risk_status || "").toUpperCase() === "HIGH RISK";
            return <div key={item.case_id} className="grid grid-cols-[100px_110px_120px_140px_minmax(200px,1fr)_70px_140px] items-center gap-3 border-b border-white/[.035] px-4 py-2.5 hover:bg-white/[.02]">
              <span className="font-mono text-[9px] text-slate-400">{item.case_id}</span>
              <button type="button" onClick={() => onAnalyze(item.account_id)} className="truncate text-left font-mono text-[10px] text-cyan-100/80 hover:text-cyan-50">{item.account_id}<ArrowUpRight size={10} className="ml-1 inline text-slate-700"/></button>
              <select aria-label={`Priority for ${item.case_id}`} value={item.priority || "MEDIUM"} disabled={savingCaseId === item.case_id} onChange={(event) => void updateCase(item, "priority", event.target.value)} className="h-7 rounded border border-white/[.08] bg-[#080c13] px-1.5 text-[8px] font-bold tracking-wider text-slate-300 outline-none focus:border-cyan-300/30 disabled:opacity-50"><option value="CRITICAL">CRITICAL</option><option value="HIGH">HIGH</option><option value="MEDIUM">MEDIUM</option><option value="LOW">LOW</option></select>
              <select aria-label={`Workflow status for ${item.case_id}`} value={(item.status || "OPEN").toUpperCase()} disabled={savingCaseId === item.case_id} onChange={(event) => void updateCase(item, "status", event.target.value)} className="h-7 rounded border border-white/[.08] bg-[#080c13] px-1.5 text-[8px] text-slate-400 outline-none focus:border-cyan-300/30 disabled:opacity-50"><option value="OPEN">OPEN</option><option value="INVESTIGATING">INVESTIGATING</option><option value="CLOSED">CLOSED</option><option value="DISMISSED">DISMISSED</option></select>
              <button type="button" onClick={() => onAnalyze(item.account_id)} className="min-w-0 text-left"><span className={`mr-2 text-[8px] font-semibold ${isHigh ? "text-rose-300" : "text-slate-400"}`}>{item.risk_status || "UNSCORED"}</span><span className="block truncate pt-1 text-[9px] text-slate-600">{item.note || "No analyst note"}</span></button>
              <span className={`text-right font-mono text-[11px] ${isHigh ? "text-rose-300" : "text-slate-300"}`}>{item.risk_score ?? "—"}<span className="ml-1 text-[8px] text-slate-600">/100</span></span>
              <div className="flex justify-end gap-1"><button type="button" onClick={() => openCaseDetails(item)} className="inline-flex h-7 items-center gap-1 rounded border border-white/[.08] px-2 text-[7px] tracking-wider text-slate-400 hover:border-cyan-300/20 hover:text-cyan-100"><FileText size={10}/> DETAILS</button><button type="button" aria-label={`Open ${item.account_id} network`} onClick={() => onAnalyze(item.account_id)} className="grid h-7 w-7 place-items-center rounded border border-white/[.08] text-slate-500 hover:text-cyan-100"><ArrowUpRight size={12}/></button></div>
            </div>;
          })}
        </div>
      </div></div>
      <div className="border-t border-white/[.04] px-4 py-2 text-[8px] text-slate-700">Set priority and move cases through review from the queue. Status and priority changes are recorded in the case timeline.</div>
    </section>
    {selectedCase && <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedCase(null); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="case-detail-title" className="glass-panel flex max-h-[min(86dvh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl shadow-2xl shadow-black/60">
        <header className="flex items-start justify-between gap-3 border-b border-white/[.07] px-5 py-4"><div><div className="text-[8px] font-bold tracking-[.17em] text-cyan-100/55">CASE RECORD · {selectedCase.status || "OPEN"}</div><h2 id="case-detail-title" className="mt-1 text-[14px] font-semibold text-slate-100">{selectedCase.case_id} <span className="font-mono text-cyan-100/80">· {selectedCase.account_id}</span></h2></div><button type="button" aria-label="Close case details" onClick={() => setSelectedCase(null)} className="grid h-8 w-8 place-items-center rounded border border-white/[.08] text-slate-500 hover:text-slate-100"><X size={14}/></button></header>
        <div className="terminal-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><CaseMetric label="PRIORITY" value={selectedCase.priority || "—"}/><CaseMetric label="RISK SCORE" value={selectedCase.risk_score === undefined ? "—" : `${selectedCase.risk_score}/100`}/><CaseMetric label="CLASSIFICATION" value={selectedCase.risk_status || "—"}/><CaseMetric label="STATUS" value={selectedCase.status || "—"}/></div>
          {selectedCase.note && <div><div className="mb-1 text-[8px] font-bold tracking-wider text-slate-500">CASE NOTE</div><p className="text-[10px] leading-relaxed text-slate-300">{selectedCase.note}</p></div>}
          <div><div className="mb-2 flex items-center justify-between"><h3 className="text-[9px] font-bold tracking-[.14em] text-slate-300">EVIDENCE RECORD</h3><span className="font-mono text-[8px] text-slate-600">{selectedCase.evidence?.length || 0} ITEMS</span></div>
            {detailLoading && <div className="flex items-center gap-2 py-5 text-[9px] text-slate-500"><RefreshCw size={12} className="animate-spin"/>Loading evidence and timeline…</div>}
            {detailError && <div role="alert" className="py-3 text-[9px] text-rose-200">{detailError}</div>}
            {!detailLoading && !detailError && !selectedCase.evidence?.length && <div className="rounded-md border border-white/[.06] px-3 py-4 text-[9px] text-slate-600">No evidence records are attached to this case yet.</div>}
            <ul className="space-y-2">{selectedCase.evidence?.map((record) => <li key={record.evidence_id} className="rounded-md border border-white/[.07] bg-black/15 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[9px] font-semibold text-cyan-100/80">{record.evidence_type || "Evidence"} <span className="ml-1 font-mono text-[7px] text-slate-600">{record.evidence_id}</span></span>{record.timestamp && <time className="font-mono text-[7px] text-slate-600">{record.timestamp}</time>}</div>{record.description && <p className="mt-2 whitespace-pre-wrap break-words text-[9px] leading-relaxed text-slate-400">{record.description}</p>}{record.transaction_ids?.length ? <div className="mt-2 border-t border-white/[.05] pt-2"><div className="mb-1 text-[7px] font-bold tracking-wider text-slate-600">VERIFIED TRANSACTION REFERENCES</div><div className="flex flex-wrap gap-1">{record.transaction_ids.map((id) => <code key={id} className="rounded border border-cyan-200/10 bg-cyan-200/[.04] px-1.5 py-1 font-mono text-[8px] text-cyan-100/80">{id}</code>)}</div></div> : null}{record.file_url && <a href={apiUrl(record.file_url)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 rounded border border-cyan-300/15 px-2 py-1.5 text-[8px] text-cyan-100 hover:bg-cyan-300/[.05]"><Paperclip size={10}/>{record.file_name || "Download evidence"}{record.file_size !== undefined && <span className="text-slate-600">· {(record.file_size / (1024 * 1024)).toFixed(1)} MB</span>}</a>}</li>)}</ul>
          </div>
          {selectedCase.timeline?.length ? (
            <div>
              <h3 className="mb-2 text-[9px] font-bold tracking-[.14em] text-slate-300">CASE TIMELINE</h3>
              <ol className="space-y-2 border-l border-white/[.08] pl-3">
                {selectedCase.timeline.slice(0, 12).map((event, index) => (
                  <li key={index} className="relative">
                    <i className="absolute -left-[17px] top-1 h-1.5 w-1.5 rounded-full bg-cyan-300/70" />
                    <div className="text-[9px] text-slate-300">{event.title || "Case activity"}</div>
                    {event.description && <div className="mt-0.5 text-[8px] leading-relaxed text-slate-600">{event.description}</div>}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
        <footer className="flex justify-end border-t border-white/[.07] px-5 py-3"><button type="button" onClick={() => { const account = selectedCase.account_id; setSelectedCase(null); onAnalyze(account); }} className="inline-flex h-8 items-center gap-1.5 rounded bg-cyan-300 px-3 text-[8px] font-bold tracking-wider text-slate-950 hover:bg-cyan-200">OPEN NETWORK <ArrowUpRight size={12}/></button></footer>
      </section>
    </div>}
  </div>;
}

function Summary({ label, value, tone = "text-slate-200" }: { label: string; value: number; tone?: string }) {
  return <div className="rounded border border-white/[.06] bg-white/[.02] px-2.5 py-1.5"><div className="text-[7px] tracking-[.13em] text-slate-600">{label}</div><div className={`mt-0.5 font-mono text-[11px] ${tone}`}>{value}</div></div>;
}

function CaseMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-white/[.07] bg-black/10 px-2.5 py-2"><div className="text-[7px] tracking-wider text-slate-600">{label}</div><div className="mt-1 truncate font-mono text-[9px] text-slate-200">{value}</div></div>;
}
