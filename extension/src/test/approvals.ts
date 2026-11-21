import type { Streamer } from "@/types/api";

/**
 * For recorder tests written before 3.0 approvals: treat every live streamer as approved for its
 * current broadcast. Tests of the approval gate itself use the real stored approvals instead.
 */
export async function approveAllLive(streamers: Streamer[]) {
  return { approved: new Set(streamers.filter((s) => s.is_live === true).map((s) => s.id)), declined: new Set<number>() };
}
