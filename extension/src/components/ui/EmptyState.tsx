import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export function EmptyState({
  icon,
  title,
  children,
  action,
  compact = false,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  tone?: "neutral" | "warn" | "danger";
}) {
  return (
    <div
      role={tone === "neutral" ? undefined : "status"}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
        tone === "neutral" && "border-ink-600 bg-ink-900/40",
        tone === "warn" && "border-warn/30 bg-warn-soft",
        tone === "danger" && "border-danger/30 bg-danger-soft",
      )}
    >
      <div
        className={cn(
          "grid place-items-center rounded-xl",
          compact ? "size-9" : "size-11",
          tone === "neutral" && "bg-ink-700 text-fg-muted",
          tone === "warn" && "bg-warn/15 text-warn",
          tone === "danger" && "bg-danger/15 text-danger",
        )}
      >
        {icon}
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {children && <div className="text-xs leading-relaxed text-fg-muted">{children}</div>}
      </div>
      {action}
    </div>
  );
}
