/**
 * Per-creator 3.0 options in My Creators: the vertical layout (with the facecam position, previewed
 * on this creator's latest clip) and what you're allowed to do with their content (rights).
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { RightsBadge, RightsForm } from "@/components/rights/RightsForm";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { clipThumbnail, listClips } from "@/local/clips";
import { rightsKey, type CreatorRights } from "@/local/rights";
import { LAYOUT_LABEL, planVertical, type LayoutKind } from "@/processing/layout";
import type { Rect, Streamer, VerticalLayout } from "@/types/api";

const PRESETS: Record<string, Rect> = {
  "Bottom right": { x: 0.75, y: 0.7, w: 0.25, h: 0.3 },
  "Bottom left": { x: 0, y: 0.7, w: 0.25, h: 0.3 },
  "Top right": { x: 0.75, y: 0, w: 0.25, h: 0.3 },
  "Top left": { x: 0, y: 0, w: 0.25, h: 0.3 },
};

/** The creator's latest clip thumbnail, for previews. */
function useLatestThumb(streamerId: number): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    void (async () => {
      const c = (await listClips()).find((x) => x.streamer_id === streamerId && x.has_thumbnail);
      const b = c ? await clipThumbnail(c.id) : undefined;
      if (!b || !alive) return;
      url = URL.createObjectURL(b);
      const i = new Image();
      i.onload = () => alive && setImg(i);
      i.src = url;
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [streamerId]);
  return img;
}

/** Draws the 9:16 result of a layout from a 16:9 frame (the same geometry the encoder uses). */
function LayoutPreview({ img, layout }: { img: HTMLImageElement | null; layout: VerticalLayout }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    ctx.fillStyle = "#0b0b10";
    ctx.fillRect(0, 0, cv.width, cv.height);
    const W = img?.naturalWidth || 1920;
    const H = img?.naturalHeight || 1080;
    const plan = planVertical(W, H, layout, 0.5, { width: cv.width, height: cv.height });
    for (const d of plan.draws) {
      if (img) ctx.drawImage(img, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
      else {
        ctx.strokeStyle = "#8b5cf6";
        ctx.strokeRect(d.dx + 1, d.dy + 1, d.dw - 2, d.dh - 2);
      }
    }
  }, [img, layout]);
  return <canvas ref={ref} width={108} height={192} className="rounded border border-ink-600" aria-label="Vertical layout preview" />;
}

function SourceFrame({ img, rect }: { img: HTMLImageElement | null; rect: Rect | null }) {
  return (
    <div className="relative aspect-video w-48 overflow-hidden rounded border border-ink-600 bg-ink-900">
      {img && <img src={img.src} alt="" className="size-full object-cover" />}
      {rect && (
        <div
          className="absolute border-2 border-accent bg-accent/20"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
          aria-label="Facecam position"
        />
      )}
      {!img && <span className="absolute inset-0 grid place-items-center text-[10px] text-fg-subtle">Preview after the first clip</span>}
    </div>
  );
}

export function LayoutEditor({ s, onSaved }: { s: Streamer; onSaved: () => void }) {
  const client = useApiClient();
  const img = useLatestThumb(s.id);
  const [kind, setKind] = useState<LayoutKind | "">(s.layout?.kind ?? "");
  const [rect, setRect] = useState<Rect>(s.layout?.facecam ?? PRESETS["Bottom right"]!);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const layout: VerticalLayout = { kind: kind || "center", facecam: kind === "facecam_top" ? rect : null };
  const pct = (k: keyof Rect) => (
    <label className="flex items-center gap-1">
      <span className="w-3 text-fg-subtle">{k}</span>
      <Input
        aria-label={`Facecam ${k} (%)`}
        className="w-16 tabular"
        inputMode="numeric"
        value={Math.round(rect[k] * 100)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) setRect({ ...rect, [k]: Math.max(0, Math.min(100, v)) / 100 });
        }}
      />
    </label>
  );
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-muted">Vertical layout</span>
        <Select aria-label={`Vertical layout for ${s.display_name}`} value={kind} onChange={(e) => setKind(e.target.value as LayoutKind | "")} className="w-56">
          <option value="">Default from Settings</option>
          {(Object.keys(LAYOUT_LABEL) as LayoutKind[]).map((k) => (
            <option key={k} value={k}>
              {LAYOUT_LABEL[k]}
            </option>
          ))}
        </Select>
      </div>
      {kind === "facecam_top" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(PRESETS).map(([name, r]) => (
              <Button key={name} size="sm" variant="ghost" onClick={() => setRect(r)}>
                {name}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">{(["x", "y", "w", "h"] as const).map(pct)}</div>
        </div>
      )}
      <div className="flex items-end gap-3">
        <SourceFrame img={img} rect={kind === "facecam_top" ? rect : null} />
        <LayoutPreview img={img} layout={layout} />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            setMsg(null);
            try {
              const saved = await client.patch<Streamer>(`/api/v1/streamers/${s.id}`, { layout: kind ? layout : null });
              setMsg(kind === "facecam_top" && saved.layout?.kind !== "facecam_top" ? "That facecam area is too small; centre crop saved instead." : "Saved. New clips use it; remake older ones in Short-form Clips.");
              onSaved();
            } catch (e) {
              setMsg(e instanceof Error ? e.message : "Could not save");
            } finally {
              setSaving(false);
            }
          }}
        >
          Save layout
        </Button>
        {msg && <span className="text-fg-subtle">{msg}</span>}
      </div>
    </div>
  );
}

export function CreatorRightsEditor({ s }: { s: Streamer }) {
  const client = useApiClient();
  const key = rightsKey(s.platform, s.platform_user_id);
  const [tick, setTick] = useState(0);
  const all = useApiQuery<CreatorRights[]>(`/api/v1/rights?_=${tick}`);
  const current = all.data?.find((r) => r.key === key) ?? null;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-fg-muted">Your rights for this creator's content</span>
        <RightsBadge rights={current} />
        {current?.confirmed_at && <span className="text-fg-subtle">confirmed {current.confirmed_at.slice(0, 10)}</span>}
      </div>
      <p className="text-fg-subtle">Recording an approved stream and clipping it stays in this browser. Publishing anywhere needs "Authorized for publishing" with the destinations you're allowed to use.</p>
      <RightsForm
        key={current?.confirmed_at ?? "none"}
        initial={current ?? undefined}
        onSubmit={async (r) => {
          await client.post(`/api/v1/rights`, { key, platform: s.platform, creator_name: s.display_name, ...r });
          setTick((x) => x + 1);
        }}
      />
    </div>
  );
}
