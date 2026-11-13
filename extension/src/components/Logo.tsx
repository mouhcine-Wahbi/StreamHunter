import { cn } from "@/utils/cn";

/** StreamHunter mark: a targeting reticle framing a play glyph. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <defs>
        <linearGradient id="sh-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#sh-g)" />
      <path
        d="M9 12V9h3M20 9h3v3M23 20v3h-3M12 23H9v-3"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14 12.6v6.8a.6.6 0 0 0 .9.5l5.4-3.4a.6.6 0 0 0 0-1l-5.4-3.4a.6.6 0 0 0-.9.5Z" fill="#fff" />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark className={compact ? "size-7" : "size-8"} />
      <div className="leading-tight">
        <div className={cn("font-semibold tracking-tight text-fg", compact ? "text-sm" : "text-[15px]")}>
          StreamHunter
        </div>
        {!compact && <div className="text-[11px] text-fg-subtle">Find the moment. Create the clip.</div>}
      </div>
    </div>
  );
}
