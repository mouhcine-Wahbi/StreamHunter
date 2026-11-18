import { Pause, Play, Square } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/Button";
import type { useMonitoring } from "@/hooks/useMonitoring";
import { cn } from "@/utils/cn";

/** Start / Pause / Resume / Stop monitoring. */
export function MonitoringToggle({
  monitoring,
  size = "md",
  className,
}: {
  monitoring: ReturnType<typeof useMonitoring>;
  size?: ButtonProps["size"];
  className?: string;
}) {
  const { state, busy, start, stop, pause, resume } = monitoring;
  if (!state.enabled)
    return (
      <Button variant="primary" size={size} loading={busy} onClick={start} icon={<Play className="size-3.5" aria-hidden />} className={className}>
        Start monitoring
      </Button>
    );
  return (
    <div className={cn("flex gap-2", className)}>
      {state.paused ? (
        <Button variant="primary" size={size} loading={busy} onClick={resume} icon={<Play className="size-3.5" aria-hidden />}>
          Resume
        </Button>
      ) : (
        <Button variant="secondary" size={size} loading={busy} onClick={pause} icon={<Pause className="size-3.5" aria-hidden />}>
          Pause
        </Button>
      )}
      <Button variant="ghost" size={size} disabled={busy} onClick={stop} icon={<Square className="size-3.5" aria-hidden />}>
        Stop monitoring
      </Button>
    </div>
  );
}
