import { Check, ExternalLink, Film, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAction } from "@/hooks/useAction";
import { useApiClient } from "@/hooks/useApiQuery";
import type { HighlightCandidate } from "@/types/api";

export function streamUrl(h: Pick<HighlightCandidate, "platform" | "streamer_username">): string | null {
  if (!h.streamer_username || !/^[A-Za-z0-9_.-]+$/.test(h.streamer_username)) return null;
  return h.platform === "twitch" ? `https://www.twitch.tv/${h.streamer_username}` : `https://kick.com/${h.streamer_username}`;
}

/** Review actions for one highlight. Nothing is ever published. */
export function HighlightActions({ h, onChanged }: { h: HighlightCandidate; onChanged: () => void }) {
  const client = useApiClient();
  const approve = useAction(async () => {
    await client.post(`/api/v1/highlights/${h.id}/approve`);
    onChanged();
  });
  const reject = useAction(async () => {
    await client.post(`/api/v1/highlights/${h.id}/reject`);
    onChanged();
  });
  const reopen = useAction(async () => {
    await client.patch(`/api/v1/highlights/${h.id}`, { status: "pending_review" });
    onChanged();
  });
  const url = streamUrl(h);
  const error = approve.error ?? reject.error ?? reopen.error;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {h.status === "pending_review" && (
          <>
            <Button size="sm" variant="primary" loading={approve.pending} icon={<Check className="size-3.5" />} onClick={() => void approve.run()}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" loading={reject.pending} icon={<X className="size-3.5" />} onClick={() => void reject.run()}>
              Reject
            </Button>
          </>
        )}
        {h.status === "approved" && (
          <Button size="sm" variant="ghost" loading={reject.pending} icon={<X className="size-3.5" />} onClick={() => void reject.run()}>
            Reject
          </Button>
        )}
        {h.status === "rejected" && (
          <Button size="sm" variant="ghost" loading={reopen.pending} icon={<RotateCcw className="size-3.5" />} onClick={() => void reopen.run()}>
            Reopen
          </Button>
        )}
        {h.clip && (
          <a href="#/clips" className="inline-flex h-8 items-center gap-1 rounded-lg bg-ink-700 px-3 text-xs text-fg hover:bg-ink-600">
            <Film className="size-3" /> Open clip
          </a>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 px-2 text-xs text-fg-muted hover:text-fg">
            <ExternalLink className="size-3" /> Open stream
          </a>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
