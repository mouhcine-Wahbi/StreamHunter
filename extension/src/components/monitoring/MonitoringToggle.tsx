import { Play, Square } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/Button";
import type { useMonitoring } from "@/hooks/useMonitoring";

export function MonitoringToggle({
  monitoring,
  size = "md",
  className,
}: {
  monitoring: ReturnType<typeof useMonitoring>;
  size?: ButtonProps["size"];
  className?: string;
}) {
  const { state, busy, start, stop } = monitoring;
  return state.enabled ? (
    <Button
      variant="secondary"
      size={size}
      loading={busy}
      onClick={stop}
      icon={<Square className="size-3.5" aria-hidden />}
      className={className}
    >
      Stop monitoring
    </Button>
  ) : (
    <Button
      variant="primary"
      size={size}
      loading={busy}
      onClick={start}
      icon={<Play className="size-3.5" aria-hidden />}
      className={className}
    >
      Start monitoring
    </Button>
  );
}
