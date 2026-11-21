/**
 * Which jobs automatic publishing creates for a clip (3.0 phase 7): only when automatic publishing
 * is on, only for destinations that are on and that your rights for this clip's source include, and
 * only for high or medium potential (medium waits for your approval). Low potential never gets a job
 * automatically; you can still publish it yourself from Publishing Studio.
 */
import { db } from "@/local/db";
import type { ContentClip } from "@/local/content";
import { createJob, type PublishJob } from "@/local/jobs";
import { check, DESTINATIONS, type Destination } from "@/local/rights";
import type { Settings } from "@/types/settings";
import { rightsForClip } from "./runner";

export async function planAuto(clipId: number, settings: Settings, now = new Date()): Promise<PublishJob[]> {
  if (!settings.publishing.autoPublish) return [];
  const clip = await db.get<ContentClip & { source_id?: number }>("clips", clipId);
  if (!clip?.viral || clip.viral.tier === "low") return [];
  const rights = await rightsForClip(clip);
  const out: PublishJob[] = [];
  for (const d of DESTINATIONS) {
    if (!settings.publishing.destinations[d].enabled || !check(rights, "publish", d).ok) continue;
    out.push(await createJob(clipId, d, { approved: false, auto: true }, now));
  }
  return out;
}

/** You chose to publish this clip to these destinations (counts as your approval). */
export async function planManual(clipId: number, destinations: Destination[], now = new Date()): Promise<PublishJob[]> {
  const clip = await db.get<ContentClip>("clips", clipId);
  if (!clip) throw new Error("That clip no longer exists.");
  const ds = [...new Set(destinations.filter((d) => DESTINATIONS.includes(d)))];
  if (!ds.length) throw new Error("Choose at least one destination.");
  const out: PublishJob[] = [];
  for (const d of ds) out.push(await createJob(clipId, d, { approved: true, auto: false }, now));
  return out;
}
