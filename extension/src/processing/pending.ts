import { listAssets } from "@/local/assets";
import { listSources } from "@/local/sources";

/** Anything waiting for the processing queue (the worker won't close the document while there is). */
export async function hasPendingWork(): Promise<boolean> {
  if ((await listAssets()).some((a) => a.status === "queued" || a.status === "processing")) return true;
  return (await listSources()).some((s) => s.analysis === "queued" || s.analysis === "analyzing" || (s.pending_clips ?? []).length > 0);
}
