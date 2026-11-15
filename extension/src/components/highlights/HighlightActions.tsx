import { Check, Clapperboard, ExternalLink, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAction } from "@/hooks/useAction";
import { useApiClient } from "@/hooks/useApiQuery";
import { useClipRequest } from "@/components/clips/useClipRequest";
import type { HighlightCandidate } from "@/types/api";

export function streamUrl(h: Pick<HighlightCandidate, "platform" | "streamer_username">): string | null {
  if (!h.streamer_username || !/^[A-Za-z0-9_.-]+$/.test(h.streamer_username)) return null;
  return h.platform === "twitch" ? `https://www.twitch.tv/${h.streamer_username}` : `https://kick.com/${h.streamer_username}`;
}

/** Review actions for one highlight. Approving never publishes anything. */
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
  const clipReq = useClipRequest(onChanged);
  const url = streamUrl(h);
  const clip = h.clip;
  const canRequest = h.platform === "twitch" && clip && (clip.status === "approved" || clip.status === "failed");
  const error = approve.error ?? reject.error ?? reopen.error ?? clipReq.error;

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
        {canRequest && (
          <Button
            size="sm"
            variant="secondary"
            loading={clipReq.pending}
            icon={<Clapperboard className="size-3.5" />}
            onClick={() => void clipReq.request(clip.id, clip.status === "failed")}
          >
            {clip.status === "failed" ? "Retry Twitch clip" : "Create Twitch clip"}
          </Button>
        )}
        {clip?.platform_clip_url && (
          <a
            href={clip.platform_clip_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-ink-700 px-3 text-xs text-fg hover:bg-ink-600"
          >
            <ExternalLink className="size-3" /> Open clip
          </a>
        )}
        {h.vod_url_at && /^https:\/\/(www\.)?twitch\.tv\//.test(h.vod_url_at) && (
          <a href={h.vod_url_at} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 px-2 text-xs text-fg-muted hover:text-fg">
            <ExternalLink className="size-3" /> Open in VOD
          </a>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 px-2 text-xs text-fg-muted hover:text-fg">
            <ExternalLink className="size-3" /> Open stream
          </a>
        )}
      </div>
      {clip?.status === "unsupported" && clip.error_message && <p className="text-xs text-warn">{clip.error_message} (Clip Library)</p>}
      {clipReq.momentPassed && (
        <div role="alertdialog" aria-label="Moment has passed" className="rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs text-warn">
          <p>{clipReq.momentPassed}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => clip && void clipReq.request(clip.id, clip.status === "failed", true)}>
              Capture current broadcast
            </Button>
            <Button size="sm" variant="ghost" onClick={clipReq.dismissMomentPassed}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
