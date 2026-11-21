/**
 * Source rights (3.0). Finding or recording a video never grants the right to republish it.
 *
 * Levels, each including the ones before it:
 *   unknown     - discovered only. Nothing is downloaded or processed; it can't be published.
 *   analysis    - you may analyse a file you provide (find moments) but not make outputs from it.
 *   processing  - you may cut clips and make vertical/landscape versions locally.
 *   publishing  - you may publish to the destinations you listed.
 * Every level above "unknown" needs your confirmation and evidence (a licence, the creator's clipping
 * programme, written permission, "my own channel"…), stored with the date.
 *
 * Recording a livestream you approved and cutting clips from it stays local (approval is the
 * permission to record); publishing still requires "publishing" rights for that creator.
 */
import type { Platform } from "@/types/api";
import { db } from "./db";

export type RightsStatus = "unknown" | "analysis" | "processing" | "publishing";
export type Destination = "youtube" | "tiktok" | "x";
export const DESTINATIONS: readonly Destination[] = ["youtube", "tiktok", "x"];
export const DESTINATION_LABEL: Record<Destination, string> = { youtube: "YouTube Shorts", tiktok: "TikTok", x: "X" };
export const RIGHTS_LABEL: Record<RightsStatus, string> = {
  unknown: "Discovered: no rights confirmed",
  analysis: "Authorized for analysis",
  processing: "Authorized for processing",
  publishing: "Authorized for publishing",
};
const ORDER: RightsStatus[] = ["unknown", "analysis", "processing", "publishing"];

export interface Rights {
  status: RightsStatus;
  /** What makes this allowed, in your words or a link. Required above "unknown". */
  evidence: string;
  /** Destinations allowed when status is "publishing". */
  destinations: Destination[];
  confirmed_at: string | null;
}

export interface CreatorRights extends Rights {
  /** `${platform}:${platform_user_id}` (or `local:<name>` for creators not on a platform). */
  key: string;
  platform: Platform | "local";
  creator_name: string;
  updated_at: string;
}

export const NO_RIGHTS: Rights = { status: "unknown", evidence: "", destinations: [], confirmed_at: null };

export const rightsKey = (platform: string, creatorId: string) => `${platform}:${creatorId}`;
export const atLeast = (r: Pick<Rights, "status"> | null | undefined, level: RightsStatus) => ORDER.indexOf(r?.status ?? "unknown") >= ORDER.indexOf(level);

export class RightsError extends Error {}

/** Validate a rights change you make. Throws RightsError with what's missing. */
export function validateRights(input: { status: RightsStatus; evidence?: string; destinations?: Destination[]; confirmed?: boolean }, now: Date): Rights {
  const status = ORDER.includes(input.status) ? input.status : "unknown";
  const evidence = (input.evidence ?? "").trim().slice(0, 1000);
  const destinations = [...new Set((input.destinations ?? []).filter((d) => DESTINATIONS.includes(d)))];
  if (status === "unknown") return { ...NO_RIGHTS };
  if (!input.confirmed) throw new RightsError("Confirm that you have these rights.");
  if (evidence.length < 3) throw new RightsError("Add the evidence for these rights (a link, licence or permission note).");
  if (status === "publishing" && destinations.length === 0) throw new RightsError("Choose at least one destination you're allowed to publish to.");
  return { status, evidence, destinations: status === "publishing" ? destinations : [], confirmed_at: now.toISOString() };
}

export type Operation = "analyze" | "process" | "publish";

/** Whether an operation is allowed, with the reason in plain words when it isn't. */
export function check(r: Rights | null | undefined, op: Operation, destination?: Destination): { ok: true } | { ok: false; reason: string } {
  const need: RightsStatus = op === "analyze" ? "analysis" : op === "process" ? "processing" : "publishing";
  if (!atLeast(r, need))
    return {
      ok: false,
      reason:
        op === "publish"
          ? `Rights unclear: publishing needs "${RIGHTS_LABEL.publishing}" for this creator (now: ${RIGHTS_LABEL[r?.status ?? "unknown"]}).`
          : `Needs "${RIGHTS_LABEL[need]}" (now: ${RIGHTS_LABEL[r?.status ?? "unknown"]}).`,
    };
  if (op === "publish" && destination && !r!.destinations.includes(destination))
    return { ok: false, reason: `Your rights for this creator don't include ${DESTINATION_LABEL[destination]}.` };
  return { ok: true };
}

// --- storage ---------------------------------------------------------------------------------------

export async function getCreatorRights(key: string): Promise<CreatorRights | null> {
  return (await db.get<CreatorRights>("rights", key)) ?? null;
}

export async function listCreatorRights(): Promise<CreatorRights[]> {
  return db.all<CreatorRights>("rights");
}

export async function setCreatorRights(
  key: string,
  meta: { platform: CreatorRights["platform"]; creator_name: string },
  input: Parameters<typeof validateRights>[0],
  now = new Date(),
): Promise<CreatorRights> {
  const r = validateRights(input, now);
  return db.putKeyed<CreatorRights>("rights", { key, ...meta, ...r, updated_at: now.toISOString() });
}
