import { useState, type FormEvent } from "react";
import { Check, ExternalLink, Plus, Radio, Search, UserSearch } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { Avatar, LiveBadge, PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { useAction } from "@/hooks/useAction";
import { ApiError } from "@/services/api-client";
import { streamUrl } from "@/local/streamers";
import { PLATFORMS, type Platform, type StreamerSearchResult } from "@/types/api";

type Result = StreamerSearchResult & { viewer_count?: number | null };

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,24}$/;

function ResultCard({ r }: { r: Result }) {
  const client = useApiClient();
  const [added, setAdded] = useState(false);
  const add = useAction(async () => {
    try {
      await client.post("/api/v1/streamers", { platform: r.platform, username: r.username });
    } catch (e) {
      // Already on the watchlist is a success from the user's point of view.
      if (!(e instanceof ApiError && e.code === "already_in_watchlist")) throw e;
    }
    setAdded(true);
  });
  return (
    <Card className="flex items-center gap-4 p-4">
      <Avatar src={r.profile_image_url} name={r.display_name} size={48} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-fg">{r.display_name}</span>
          <PlatformBadge platform={r.platform} />
          <LiveBadge isLive={r.is_live} />
        </div>
        <div className="mt-0.5 truncate text-xs text-fg-muted">
          {r.current_category ?? "No category"}
          {r.is_live && typeof r.viewer_count === "number" ? ` · ${r.viewer_count.toLocaleString()} viewers` : ""}
          {r.current_title ? ` · ${r.current_title}` : ""}
        </div>
        {add.error && <div className="mt-1 text-xs text-danger">{add.error}</div>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Open ${r.display_name}'s stream`}
        icon={<ExternalLink className="size-3.5" />}
        onClick={() => void chrome.tabs.create({ url: streamUrl(r) })}
      />
      <Button
        variant={added ? "secondary" : "primary"}
        size="sm"
        loading={add.pending}
        disabled={added}
        onClick={() => void add.run()}
        icon={added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
      >
        {added ? "Monitoring" : "Add"}
      </Button>
    </Card>
  );
}

export function DiscoverPage() {
  const [platform, setPlatform] = useState<Platform>("twitch");
  const [username, setUsername] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  const query = useApiQuery<Result[]>(submitted);
  const live = useApiQuery<Result[]>(submitted === null ? `/api/v1/discover/live?platform=${platform}&limit=24` : null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const u = username.trim();
    if (!USERNAME_RE.test(u)) {
      setValidation("Enter a channel name (2–25 letters, numbers or underscores).");
      return;
    }
    setValidation(null);
    setSubmitted(`/api/v1/streamers/search?platform=${platform}&username=${encodeURIComponent(u)}`);
  }

  return (
    <>
      <PageHeader title="Discover" description="Search Twitch and Kick channels, see who is live, and add them to your monitoring list." />
      <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-3" role="search">
        <Segmented
          label="Platform"
          value={platform}
          options={PLATFORMS}
          onChange={(p) => {
            setPlatform(p);
            setSubmitted(null);
          }}
        />
        <div className="min-w-64 flex-1">
          <Input
            aria-label="Channel name"
            placeholder={platform === "twitch" ? "Twitch channel, e.g. shroud" : "Kick channel slug, e.g. xqc"}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-invalid={validation ? true : undefined}
          />
          {validation ? (
            <p className="mt-1.5 text-xs text-danger">{validation}</p>
          ) : (
            platform === "kick" && (
              <p className="mt-1.5 text-xs text-fg-subtle">Kick has no search API: enter the exact channel name from kick.com/&lt;name&gt;.</p>
            )
          )}
        </div>
        <Button type="submit" variant="primary" icon={<Search className="size-4" />}>
          Search
        </Button>
      </form>

      <div className="mt-6">
        {submitted === null ? (
          <section aria-labelledby="live-now">
            <h2 id="live-now" className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
              <Radio className="size-4" /> Live now on {platform === "twitch" ? "Twitch" : "Kick"}
            </h2>
            <ApiStateView query={live} feature="live channels">
              {(results) =>
                results.length === 0 ? (
                  <EmptyState icon={<UserSearch className="size-5" />} title="Nobody live right now">
                    Search for a channel above.
                  </EmptyState>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {results.map((r) => (
                      <ResultCard key={`${r.platform}:${r.platform_user_id}`} r={r} />
                    ))}
                  </div>
                )
              }
            </ApiStateView>
          </section>
        ) : (
          <ApiStateView query={query} feature="search results">
            {(results) =>
              results.length === 0 ? (
                <EmptyState icon={<UserSearch className="size-5" />} title="No channels found">
                  Check the spelling or try the other platform.
                </EmptyState>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {results.map((r) => (
                    <ResultCard key={`${r.platform}:${r.platform_user_id}`} r={r} />
                  ))}
                </div>
              )
            }
          </ApiStateView>
        )}
      </div>
    </>
  );
}
