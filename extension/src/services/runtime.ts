import type { ResponseMap, RuntimeRequest, RuntimeResponse } from "@/types/messages";

/** Typed request/response to the background service worker. */
export async function sendRequest<R extends RuntimeRequest>(request: R): Promise<ResponseMap[R["type"]]> {
  const res = (await chrome.runtime.sendMessage(request)) as RuntimeResponse<ResponseMap[R["type"]]> | undefined;
  if (!res) throw new Error("No response from the StreamHunter background worker");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
