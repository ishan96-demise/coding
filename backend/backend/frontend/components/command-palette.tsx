"use client";

import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { Activity, ArrowRight, Bot, BriefcaseBusiness, Search, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: string) => void;
  onAnalyze: (account: string) => void;
};

export function CommandPalette({ open, onOpenChange, onNavigate, onAnalyze }: Props) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [open, onOpenChange]);

  const runSearch = () => {
    const account = query.trim().toUpperCase().replace(/^ANALYZE\s+/, "");
    if (!account) return;
    onAnalyze(account);
    setQuery("");
    onOpenChange(false);
  };

  return (
    <AnimatePresence>
      {open && <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 px-4 pt-[14vh] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && onOpenChange(false)}>
        <motion.div initial={{ opacity: 0, y: -12, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: .16 }} className="w-full max-w-[570px] overflow-hidden rounded-xl border border-white/10 bg-[#0d121b] shadow-[0_24px_90px_rgba(0,0,0,.62)]">
          <Command label="Fin Sentinels command palette" className="text-sm">
            <div className="flex items-center gap-3 border-b border-white/[.08] px-4">
              <Search size={15} className="text-cyan-200" />
              <Command.Input value={query} onValueChange={setQuery} onKeyDown={(event) => event.key === "Enter" && runSearch()} autoFocus placeholder="Search accounts, open a view, or run an analysis…" className="h-12 w-full bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-600" />
              <kbd className="rounded border border-white/10 px-1.5 py-1 text-[9px] text-slate-500">ESC</kbd>
            </div>
            <Command.List className="terminal-scroll max-h-[380px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-xs text-slate-500">No matching command. Press Enter to investigate this account.</Command.Empty>
              <Command.Group heading="Workspace" className="px-2 py-1.5 text-[9px] font-bold uppercase tracking-[.18em] text-slate-600 [&_[cmdk-item]]:mt-1">
                <PaletteItem icon={<Activity size={14} />} title="Network overview" shortcut="G O" onSelect={() => { onNavigate("overview"); onOpenChange(false); }} />
                <PaletteItem icon={<ShieldAlert size={14} />} title="Fraud networks" shortcut="G N" onSelect={() => { onNavigate("networks"); onOpenChange(false); }} />
                <PaletteItem icon={<Bot size={14} />} title="AI agent signals" shortcut="G A" onSelect={() => { onNavigate("agents"); onOpenChange(false); }} />
                <PaletteItem icon={<BriefcaseBusiness size={14} />} title="Case queue" shortcut="G C" onSelect={() => { onNavigate("cases"); onOpenChange(false); }} />
              </Command.Group>
              <Command.Group heading="Investigate account" className="px-2 py-1.5 text-[9px] font-bold uppercase tracking-[.18em] text-slate-600 [&_[cmdk-item]]:mt-1">
                {["ACC_097", "ACC_080", "ACC_070", "ACC_001"].map((account) => <PaletteItem key={account} icon={<Search size={14} />} title={account} detail="Analyze linked network" onSelect={() => { onAnalyze(account); onOpenChange(false); }} />)}
                {query && <PaletteItem icon={<ArrowRight size={14} />} title={`Investigate “${query}”`} detail="Open live graph analysis" onSelect={runSearch} />}
              </Command.Group>
            </Command.List>
            <div className="flex items-center justify-between border-t border-white/[.07] px-4 py-2 text-[9px] text-slate-600"><span>FIN SENTINELS · COMMAND ROUTER</span><span><kbd className="rounded border border-white/10 px-1">↵</kbd> select</span></div>
          </Command>
        </motion.div>
      </motion.div>}
    </AnimatePresence>
  );
}

function PaletteItem({ icon, title, detail, shortcut, onSelect }: { icon: React.ReactNode; title: string; detail?: string; shortcut?: string; onSelect: () => void }) {
  return <Command.Item value={`${title} ${detail || ""}`} onSelect={onSelect} className="flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-slate-300 aria-selected:bg-cyan-300/[.09] aria-selected:text-cyan-100">
    <span className="text-cyan-200/70">{icon}</span><span className="flex-1 text-xs font-medium">{title}{detail && <span className="ml-2 text-[10px] font-normal text-slate-600">{detail}</span>}</span>{shortcut && <kbd className="text-[9px] text-slate-600">{shortcut}</kbd>}
  </Command.Item>;
}
