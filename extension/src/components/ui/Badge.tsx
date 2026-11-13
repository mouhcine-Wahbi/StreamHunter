import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export type BadgeTone = "neutral" | "accent" | "live" | "warn" | "danger" | "twitch" | "kick";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-ink-700 text-fg-muted border-ink-600",
  accent: "bg-accent-soft text-[#c4b5fd] border-accent/30",
  live: "bg-live-soft text-live border-live/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  twitch: "bg-twitch/12 text-twitch border-twitch/30",
  kick: "bg-kick/10 text-kick border-kick/30",
};

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export function Dot({ tone, pulse = false }: { tone: "live" | "warn" | "danger" | "neutral" | "accent"; pulse?: boolean }) {
  const color = {
    live: "bg-live text-live",
    warn: "bg-warn text-warn",
    danger: "bg-danger text-danger",
    neutral: "bg-fg-subtle text-fg-subtle",
    accent: "bg-accent text-accent",
  }[tone];
  return <span aria-hidden className={cn("inline-block size-2 rounded-full", color, pulse && "animate-live")} />;
}
