import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Button({
  children,
  className,
  variant = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "ghost" | "outline" }) {
  const variants = {
    default: "bg-cyan-300 text-slate-950 hover:bg-cyan-200",
    ghost: "bg-transparent text-slate-400 hover:bg-white/[0.06] hover:text-white",
    outline: "border border-white/10 bg-white/[0.025] text-slate-300 hover:border-cyan-300/40 hover:text-white",
  };
  return (
    <button className={cn("inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition disabled:pointer-events-none disabled:opacity-50", variants[variant], className)} {...props}>
      {children}
    </button>
  );
}
