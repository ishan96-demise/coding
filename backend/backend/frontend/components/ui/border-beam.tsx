export function BorderBeam({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`border-beam pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] ${className}`}><i/></span>;
}
