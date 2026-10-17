import { cn } from "@/components/ui/button";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-white/[.08] bg-[#0d121b]/95 shadow-[0_12px_38px_rgba(0,0,0,.2)]", className)} {...props}/>;
}
