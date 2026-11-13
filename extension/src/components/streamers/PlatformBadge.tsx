import { Badge } from "@/components/ui/Badge";
import type { Platform } from "@/types/api";

export function PlatformBadge({ platform }: { platform: Platform }) {
  return <Badge tone={platform}>{platform === "twitch" ? "Twitch" : "Kick"}</Badge>;
}

export function LiveBadge({ isLive }: { isLive: boolean | null }) {
  if (isLive === null) return <Badge tone="neutral">Status unknown</Badge>;
  return isLive ? (
    <Badge tone="danger" className="!bg-danger !text-white !border-danger font-semibold tracking-wide">
      LIVE
    </Badge>
  ) : (
    <Badge tone="neutral">Offline</Badge>
  );
}

export function Avatar({ src, name, size = 40 }: { src: string | null; name: string; size?: number }) {
  const initials = name.slice(0, 2).toUpperCase();
  return src ? (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full border border-ink-600 bg-ink-700 object-cover"
      style={{ width: size, height: size }}
      referrerPolicy="no-referrer"
    />
  ) : (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full border border-ink-600 bg-ink-700 text-xs font-semibold text-fg-muted"
      style={{ width: size, height: size }}
    >
      {initials}
    </div>
  );
}
