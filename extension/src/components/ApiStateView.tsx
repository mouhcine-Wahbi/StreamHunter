import type { ReactNode } from "react";
import { KeyRound, Loader2, PlugZap, TriangleAlert } from "lucide-react";
import { ApiError } from "@/services/api-client";
import type { QueryState } from "@/hooks/useApiQuery";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { sendRequest } from "@/services/runtime";

/** Opens Settings: in place inside the workspace, otherwise in a workspace tab. */
function openSettings() {
  if (document.querySelector('[data-surface="workspace"]')) {
    location.hash = "/settings";
    return;
  }
  void sendRequest({ type: "app/open", route: "/settings" }).then(() => window.close());
}

/**
 * Renders loading / error states of a local query truthfully, and the
 * children only when real data is available. Never substitutes sample data.
 */
export function ApiStateView<T>({
  query,
  feature,
  compact = false,
  children,
}: {
  query: QueryState<T>;
  /** Human name of what is being loaded, e.g. "your watchlist". */
  feature: string;
  compact?: boolean;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading, reload } = query;

  if (loading && data === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading {feature}…
      </div>
    );
  }

  if (error) {
    const retry = (
      <Button size="sm" variant="secondary" onClick={reload}>
        Retry
      </Button>
    );
    if (error instanceof ApiError && error.code === "platform_not_configured") {
      return (
        <EmptyState
          compact={compact}
          tone="warn"
          icon={<KeyRound className="size-5" />}
          title="Not available yet"
          action={
            <Button size="sm" variant="primary" onClick={openSettings}>
              Open Settings
            </Button>
          }
        >
          {error.message}
        </EmptyState>
      );
    }
    if (error instanceof ApiError && error.kind === "http" && (error.status === 501 || error.status === 503)) {
      return (
        <EmptyState compact={compact} tone="warn" icon={<PlugZap className="size-5" />} title="Not available yet">
          {error.message}
        </EmptyState>
      );
    }
    return (
      <EmptyState
        compact={compact}
        tone="danger"
        icon={<TriangleAlert className="size-5" />}
        title={`Could not load ${feature}`}
        action={retry}
      >
        {error.message}
      </EmptyState>
    );
  }

  if (data === null) return null;
  return <>{children(data)}</>;
}
