/**
 * Short-form Clips (vertical 9:16 for YouTube Shorts and TikTok) and X Clips (native landscape).
 * Each clip's version is made locally in this browser; you can preview it, see which layout was
 * used and why, and remake it with another layout for this clip only.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Film, RefreshCw, Smartphone, Twitter } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import { sendRequest } from "@/services/runtime";
import { assetBlob, assetThumbnail, type Asset, type AssetKind, type AssetStatus } from "@/local/assets";
import { clipThumbnail, type LocalClip } from "@/local/clips";
import { LAYOUT_LABEL, type LayoutKind } from "@/processing/layout";
import { useObjectUrl } from "@/pages/clips/ClipCard";
import type { Page } from "@/types/api";
import { formatRelative } from "@/utils/format";
import type { ContentClip } from "@/local/content";
import { ContentPanel } from "./ContentPanel";

const STATUS: Record<AssetStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: "Waiting", tone: "neutral" },
  processing: { label: "Making…", tone: "accent" },
  ready: { label: "Ready", tone: "live" },
  failed: { label: "Failed", tone: "danger" },
};
const SOURCE_LABEL = { clip: "chosen for this clip", creator: "creator's layout", default: "default from Settings" } as const;

function Preview({ asset, clip, vertical }: { asset: Asset | undefined; clip: LocalClip; vertical: boolean }) {
  const ready = asset?.status === "ready";
  const video = useObjectUrl(() => (ready ? assetBlob(asset!) : Promise.resolve(undefined)), ready ? asset!.id * 10 + 1 : -1);
  const thumb = useObjectUrl(() => (asset?.has_thumbnail ? assetThumbnail(asset.id) : clip.has_thumbnail ? clipThumbnail(clip.id) : Promise.resolve(undefined)), (asset?.id ?? 0) * 1000 + clip.id);
  return (
    <div className={vertical ? "aspect-[9/16] w-40 shrink-0 overflow-hidden rounded-lg bg-black" : "aspect-video w-72 shrink-0 overflow-hidden rounded-lg bg-black"}>
      {video ? (
        <video src={video} poster={thumb ?? undefined} controls preload="metadata" className="size-full object-contain" aria-label={`Preview of ${clip.title ?? "clip"}`} />
      ) : thumb ? (
        <img src={thumb} alt="" className="size-full object-cover opacity-50" />
      ) : (
        <div className="grid size-full place-items-center text-fg-subtle">
          <Film className="size-6" />
        </div>
      )}
    </div>
  );
}

function FormatRow({ clip, asset, kind, onChanged }: { clip: LocalClip; asset: Asset | undefined; kind: AssetKind; onChanged: () => void }) {
  const [layout, setLayout] = useState<LayoutKind | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vertical = kind === "vertical";
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendRequest({ type: "assets/make", clipId: clip.id, kinds: [kind], layout: vertical && layout ? { kind: layout } : null });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(false);
    }
  };
  const st = asset ? STATUS[asset.status] : null;
  return (
    <Card className="flex gap-4 p-4">
      <Preview asset={asset} clip={clip} vertical={vertical} />
      <div className="min-w-0 flex-1 space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-fg">{clip.title ?? "Untitled clip"}</h3>
          {st ? <Badge tone={st.tone}>{asset!.status === "processing" ? `Making… ${Math.round(asset!.progress * 100)}%` : st.label}</Badge> : <Badge>Not made</Badge>}
        </div>
        <p className="text-fg-subtle">
          {clip.streamer_display_name} · {clip.duration_seconds ?? "?"} s original · clipped {formatRelative(clip.created_at)}
        </p>
        {asset?.status === "ready" && (
          <p className="text-fg-muted">
            {asset.width}×{asset.height} · {asset.duration_seconds} s · {(asset.size_bytes / 1024 ** 2).toFixed(1)} MB
            {vertical && asset.used_layout && asset.used_layout !== "landscape" ? ` · ${LAYOUT_LABEL[asset.used_layout]}${asset.layout_source ? ` (${SOURCE_LABEL[asset.layout_source]})` : ""}` : ""}
            {asset.reused_original ? " · original file, no copy" : ""}
          </p>
        )}
        {asset?.notes.map((n) => (
          <p key={n} className="text-fg-subtle">
            {n}
          </p>
        ))}
        {(asset?.error || error) && <p className="text-danger">{error ?? asset!.error}</p>}
        <ContentPanel clip={clip as ContentClip} dests={vertical ? ["youtube", "tiktok"] : ["x"]} onChanged={onChanged} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {vertical && (
            <Select aria-label={`Layout for ${clip.title ?? "clip"}`} value={layout} onChange={(e) => setLayout(e.target.value as LayoutKind | "")} className="w-56">
              <option value="">Creator / default layout</option>
              {(Object.keys(LAYOUT_LABEL) as LayoutKind[]).map((k) => (
                <option key={k} value={k}>
                  {LAYOUT_LABEL[k]} (this clip only)
                </option>
              ))}
            </Select>
          )}
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={busy} disabled={asset?.status === "processing" || asset?.status === "queued"} onClick={() => void make()}>
            {asset ? "Remake" : "Make"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function FormatsPage({ kind }: { kind: AssetKind }) {
  const [tick, setTick] = useState(0);
  const clips = useApiQuery<Page<LocalClip>>(`/api/v1/clips?limit=200&_=${tick}`);
  const assets = useApiQuery<Asset[]>(`/api/v1/assets?_=${tick}`);
  const mine = (assets.data ?? []).filter((a) => a.kind === kind);
  const working = mine.some((a) => a.status === "queued" || a.status === "processing");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setTick((x) => x + 1), 2500);
    return () => clearInterval(t);
  }, [working]);
  const vertical = kind === "vertical";
  const header: ReactNode = vertical ? (
    <PageHeader title="Short-form Clips" description="Vertical 9:16 versions (1080×1920, H.264 + AAC) for YouTube Shorts and TikTok, made in this browser. Layout per creator in My Creators; per clip here." />
  ) : (
    <PageHeader title="X Clips" description="Native landscape versions for X (up to 1920×1200 and 140 s, H.264 + AAC). When the original clip already fits, it's used as it is." />
  );
  return (
    <>
      {header}
      <ApiStateView query={clips} feature="clips">
        {(p) =>
          p.items.length === 0 ? (
            <EmptyState icon={vertical ? <Smartphone className="size-5" /> : <Twitter className="size-5" />} title="No clips yet">
              Clips from approved recordings and from your authorized files appear here with their {vertical ? "vertical" : "landscape"} version.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {p.items.map((c) => (
                <FormatRow key={c.id} clip={c} asset={mine.find((a) => a.clip_id === c.id)} kind={kind} onChanged={() => setTick((x) => x + 1)} />
              ))}
            </div>
          )
        }
      </ApiStateView>
    </>
  );
}
