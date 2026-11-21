/**
 * Every check a job must pass before anything is sent to a platform (3.0 phase 7), in this order:
 * destination on → rights for this destination → account connected → the right file is ready →
 * text written → not already published → potential tier / your approval → daily limit.
 */
import type { Asset } from "@/local/assets";
import type { ContentClip } from "@/local/content";
import type { PublishJob } from "@/local/jobs";
import { check, DESTINATION_LABEL, type Rights } from "@/local/rights";
import type { Settings } from "@/types/settings";
import type { AccountView } from "./accounts";

export type Preflight =
  | { action: "go"; asset: Asset }
  | { action: "wait"; reason: string; until?: string }
  | { action: "block"; reason: string }
  | { action: "approval"; reason: string };

export interface PreflightInput {
  job: PublishJob;
  clip: ContentClip;
  assets: Asset[];
  rights: Rights | null;
  account: AccountView;
  settings: Settings;
  /** Other jobs for this clip. */
  siblings: PublishJob[];
  publishedToday: number;
  now: Date;
}

export const kindFor = (d: PublishJob["destination"]) => (d === "x" ? "landscape" : "vertical");

export function preflight(i: PreflightInput): Preflight {
  const d = i.job.destination;
  const label = DESTINATION_LABEL[d];
  const s = i.settings.publishing;
  if (!s.destinations[d].enabled) return { action: "block", reason: `Publishing to ${label} is turned off in Settings.` };

  const r = check(i.rights, "publish", d);
  if (!r.ok) return { action: "block", reason: r.reason };

  if (!i.account.configured || !i.account.connected) return { action: "block", reason: `Connect your ${label} account first (Settings → Publishing).` };
  if (i.account.problem) return { action: "block", reason: i.account.problem };

  const kind = kindFor(d);
  const asset = i.assets.find((a) => a.kind === kind);
  if (!asset) return { action: "wait", reason: `Waiting for the ${kind} version to be made.` };
  if (asset.status === "failed") return { action: "block", reason: `The ${kind} version failed: ${asset.error ?? "unknown error"}. Remake it first.` };
  if (asset.status !== "ready") return { action: "wait", reason: `Waiting for the ${kind} version to be made.` };

  const meta = i.clip.metadata?.byDestination[d];
  if (!meta) return { action: "wait", reason: "Waiting for the title and text." };
  if (d === "youtube" && !meta.title.trim()) return { action: "block", reason: "The YouTube title is empty." };

  const dup = i.siblings.find((j) => j.id !== i.job.id && j.destination === d && ["published", "uploading", "confirming"].includes(j.state));
  if (dup) return { action: "block", reason: dup.state === "published" ? `Already published to ${label}${dup.url ? ` (${dup.url})` : ""}.` : `Another job is already uploading this clip to ${label}.` };

  if (!i.job.approved) {
    const v = i.clip.viral;
    if (!v) return { action: "wait", reason: "Waiting for the viral-potential score." };
    if (v.tier === "low") return { action: "block", reason: `Low potential (${v.total}): not published automatically. Approve it yourself to publish.` };
    if (v.tier === "medium") return { action: "approval", reason: v.summary };
    if (!s.autoPublish) return { action: "approval", reason: `High potential (${v.total}), but automatic publishing is off.` };
  }

  if (i.publishedToday >= s.destinations[d].dailyLimit) {
    const tomorrow = new Date(i.now);
    tomorrow.setHours(24, 0, 0, 0);
    return { action: "wait", reason: `Daily limit for ${label} reached (${s.destinations[d].dailyLimit}); continues tomorrow.`, until: tomorrow.toISOString() };
  }
  return { action: "go", asset };
}
