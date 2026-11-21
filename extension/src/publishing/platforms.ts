/**
 * Uploads to each destination with its documented API (3.0 phase 7), and nothing else:
 *
 *   YouTube: resumable upload (POST …/upload/youtube/v3/videos?uploadType=resumable, then PUT the
 *            file to the returned Location). Confirmed when videos.list reports uploadStatus
 *            "processed".
 *   TikTok:  Content Posting API Direct Post: creator_info/query → video/init (FILE_UPLOAD) → PUT
 *            chunks to upload_url (5–64 MB, last chunk takes the remainder) → status/fetch until
 *            PUBLISH_COMPLETE. Unaudited TikTok apps can only post privately (SELF_ONLY).
 *   X:       v2 chunked media upload (initialize → append → finalize → STATUS while processing),
 *            then POST /2/tweets with the media id. Confirmed by the created post's id.
 *
 * A clip is "published" only when the platform confirms it; uploads that are accepted but not yet
 * processed are "confirming".
 */
import type { Destination } from "@/local/rights";
import type { DestinationMeta } from "@/metadata/metadata";
import type { Settings } from "@/types/settings";
import type { Profile } from "./accounts";

export class PublishError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The platform may have created the post anyway; never retry automatically. */
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

export interface UploadInput {
  blob: Blob;
  meta: DestinationMeta;
  durationSec: number;
  settings: Settings;
  token: string;
  profile: Profile;
  fetchImpl?: typeof fetch;
  onProgress?: (p: number) => void;
  /** X only: called right before the post is created (so a crash after it is never retried blindly). */
  beforePost?: () => Promise<void>;
}

export type UploadOutcome = { kind: "published"; platformId: string; url: string | null } | { kind: "confirming"; ref: string; note: string };
export type ConfirmOutcome = { kind: "published"; platformId: string; url: string | null } | { kind: "pending"; note: string; afterSec?: number } | { kind: "failed"; reason: string };

export interface Metrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  fetched_at: string;
}

const PLATFORM: Record<Destination, string> = { youtube: "YouTube", tiktok: "TikTok", x: "X" };

/** Turns a platform's error answer into a message and whether retrying could help. */
async function fail(dest: Destination, r: Response, step: string): Promise<never> {
  const text = await r.text().catch(() => "");
  let msg = "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error as { message?: string; code?: string } | string | undefined;
    msg = (typeof e === "string" ? e : e?.message || e?.code) || (j.detail as string) || (j.title as string) || ((j.errors as { message?: string }[] | undefined)?.[0]?.message ?? "");
  } catch {
    msg = text.slice(0, 120);
  }
  const retryable = r.status === 429 || r.status >= 500;
  const why = r.status === 401 ? "the sign-in was rejected; connect the account again" : r.status === 403 ? "not allowed" : r.status === 429 ? "rate limit reached" : `HTTP ${r.status}`;
  throw new PublishError(`${PLATFORM[dest]} ${step}: ${why}${msg ? ` (${String(msg).slice(0, 200)})` : ""}.`, retryable);
}

async function call(dest: Destination, f: typeof fetch, step: string, url: string, init: RequestInit): Promise<Response> {
  let r: Response;
  try {
    r = await f(url, init);
  } catch {
    throw new PublishError(`${PLATFORM[dest]} ${step}: couldn't reach the platform.`, true);
  }
  if (!r.ok && r.status !== 308) await fail(dest, r, step);
  return r;
}

/** The file and your token only ever go to the platform's own upload hosts. */
export function uploadHostOk(dest: "youtube" | "tiktok", url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return dest === "youtube" ? u.hostname === "www.googleapis.com" || u.hostname.endsWith(".googleapis.com") : u.hostname === "tiktokapis.com" || u.hostname.endsWith(".tiktokapis.com");
  } catch {
    return false;
  }
}

const handle = (h: string) => encodeURIComponent(h.replace(/^@/, ""));

const withTags = (text: string, tags: string[]) => [text.trim(), tags.join(" ")].filter(Boolean).join(text.includes("\n") ? "\n\n" : " ");

// --- YouTube -------------------------------------------------------------------------------------

export const YT = {
  upload: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
  videos: "https://www.googleapis.com/youtube/v3/videos",
};

async function youtubeUpload(i: UploadInput): Promise<UploadOutcome> {
  const f = i.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${i.token}` };
  const metadata = {
    snippet: { title: i.meta.title, description: withTags(i.meta.description, i.meta.hashtags), tags: i.meta.hashtags.map((t) => t.replace(/^#/, "")), categoryId: "20" },
    status: { privacyStatus: i.settings.publishing.youtubePrivacy, selfDeclaredMadeForKids: false },
  };
  const start = await call("youtube", f, "upload start", YT.upload, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(i.blob.size), "x-upload-content-type": "video/mp4" },
    body: JSON.stringify(metadata),
  });
  const location = start.headers.get("location");
  if (!location) throw new PublishError("YouTube upload start: no upload address returned.", true);
  if (!uploadHostOk("youtube", location)) throw new PublishError("YouTube returned an upload address outside googleapis.com; nothing was sent.", false);
  i.onProgress?.(0.1);
  const put = await call("youtube", f, "upload", location, { method: "PUT", headers: { ...auth, "content-type": "video/mp4" }, body: i.blob });
  i.onProgress?.(1);
  const v = (await put.json().catch(() => null)) as { id?: string; status?: { uploadStatus?: string } } | null;
  if (!v?.id) throw new PublishError("YouTube accepted the file but returned no video id.", false, true);
  return { kind: "confirming", ref: v.id, note: "Uploaded; waiting for YouTube to process it." };
}

async function youtubeConfirm(ref: string, token: string, f: typeof fetch): Promise<ConfirmOutcome> {
  const r = await call("youtube", f, "status", `${YT.videos}?part=status&id=${encodeURIComponent(ref)}`, { headers: { authorization: `Bearer ${token}` } });
  const v = ((await r.json()) as { items?: { id: string; status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string } }[] }).items?.[0];
  if (!v) return { kind: "failed", reason: "YouTube no longer has this video (deleted or never finished)." };
  const s = v.status?.uploadStatus;
  if (s === "processed") return { kind: "published", platformId: v.id, url: `https://www.youtube.com/shorts/${encodeURIComponent(v.id)}` };
  if (s === "uploaded") return { kind: "pending", note: "YouTube is processing the video." };
  return { kind: "failed", reason: `YouTube ${s ?? "error"}${v.status?.rejectionReason ? `: ${v.status.rejectionReason}` : v.status?.failureReason ? `: ${v.status.failureReason}` : ""}.` };
}

// --- TikTok --------------------------------------------------------------------------------------

export const TT = {
  creatorInfo: "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
  init: "https://open.tiktokapis.com/v2/post/publish/video/init/",
  status: "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
  query: "https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count",
};
const MB = 1024 * 1024;

/** TikTok's chunk rules: < 5 MB whole; ≤ 64 MB may be one chunk; otherwise 10 MB chunks, the last one takes the remainder. */
export function tiktokChunks(size: number): { chunkSize: number; count: number; ranges: [number, number][] } {
  const chunkSize = size <= 64 * MB ? size : 10 * MB;
  const count = Math.max(1, Math.floor(size / chunkSize));
  const ranges: [number, number][] = [];
  for (let k = 0; k < count; k++) ranges.push([k * chunkSize, k === count - 1 ? size - 1 : (k + 1) * chunkSize - 1]);
  return { chunkSize, count, ranges };
}

async function tiktokJson(r: Response | string, step: string): Promise<Record<string, unknown>> {
  let j: { data?: Record<string, unknown>; error?: { code?: string; message?: string } } = {};
  try {
    j = JSON.parse(typeof r === "string" ? r : await r.text());
  } catch {
    /* no body */
  }
  if (j.error?.code && j.error.code !== "ok") throw new PublishError(`TikTok ${step}: ${j.error.message || j.error.code}.`, j.error.code === "rate_limit_exceeded" || j.error.code === "internal_error");
  return j.data ?? {};
}

async function tiktokUpload(i: UploadInput): Promise<UploadOutcome> {
  const f = i.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${i.token}`, "content-type": "application/json; charset=UTF-8" };
  const info = await tiktokJson(await call("tiktok", f, "account check", TT.creatorInfo, { method: "POST", headers }), "account check");
  const options = (info.privacy_level_options as string[] | undefined) ?? [];
  const privacy = i.settings.publishing.tiktokPrivacy;
  if (!options.includes(privacy)) throw new PublishError(`TikTok doesn't offer "${privacy}" for this account (offered: ${options.join(", ") || "none"}). Change it in Settings → Publishing.`, false);
  const max = Number(info.max_video_post_duration_sec ?? 0);
  if (max && i.durationSec > max) throw new PublishError(`This account can post videos up to ${max} s on TikTok; the clip is ${Math.round(i.durationSec)} s.`, false);
  const plan = tiktokChunks(i.blob.size);
  const init = await tiktokJson(
    await call("tiktok", f, "post start", TT.init, {
      method: "POST",
      headers,
      body: JSON.stringify({
        post_info: {
          title: withTags(i.meta.description, i.meta.hashtags).slice(0, 2200),
          privacy_level: privacy,
          disable_duet: Boolean(info.duet_disabled),
          disable_stitch: Boolean(info.stitch_disabled),
          disable_comment: Boolean(info.comment_disabled),
          brand_content_toggle: false,
          brand_organic_toggle: false,
          is_aigc: false,
        },
        source_info: { source: "FILE_UPLOAD", video_size: i.blob.size, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
      }),
    }),
    "post start",
  );
  const publishId = init.publish_id as string | undefined;
  const uploadUrl = init.upload_url as string | undefined;
  if (!publishId || !uploadUrl) throw new PublishError("TikTok returned no upload address.", true);
  if (!uploadHostOk("tiktok", uploadUrl)) throw new PublishError("TikTok returned an upload address outside tiktokapis.com; nothing was sent.", false);
  for (const [k, [a, b]] of plan.ranges.entries()) {
    await call("tiktok", f, `upload part ${k + 1}/${plan.count}`, uploadUrl, { method: "PUT", headers: { "content-type": "video/mp4", "content-range": `bytes ${a}-${b}/${i.blob.size}` }, body: i.blob.slice(a, b + 1) });
    i.onProgress?.((k + 1) / plan.count);
  }
  return { kind: "confirming", ref: publishId, note: "Sent to TikTok; waiting for TikTok to post it." };
}

async function tiktokConfirm(ref: string, token: string, profile: Profile, f: typeof fetch): Promise<ConfirmOutcome> {
  const text = await (await call("tiktok", f, "status", TT.status, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ publish_id: ref }) })).text();
  const d = await tiktokJson(text, "status");
  const s = d.status as string | undefined;
  if (s === "PUBLISH_COMPLETE") {
    // Post ids are int64 numbers in TikTok's JSON; read them from the text so no digit is lost.
    const id = /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)/.exec(text)?.[1];
    // Without a public id (e.g. private posts) TikTok gives no link; the publish id is kept as proof.
    return { kind: "published", platformId: id ? String(id) : ref, url: id && profile.handle ? `https://www.tiktok.com/@${handle(profile.handle)}/video/${id}` : null };
  }
  if (s === "FAILED") return { kind: "failed", reason: `TikTok: ${(d.fail_reason as string) || "the post failed"}.` };
  return { kind: "pending", note: s === "PROCESSING_UPLOAD" ? "TikTok is processing the upload." : `TikTok status: ${s ?? "unknown"}.` };
}

// --- X -------------------------------------------------------------------------------------------

export const XAPI = {
  init: "https://api.x.com/2/media/upload/initialize",
  append: (id: string) => `https://api.x.com/2/media/upload/${id}/append`,
  finalize: (id: string) => `https://api.x.com/2/media/upload/${id}/finalize`,
  status: (id: string) => `https://api.x.com/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`,
  tweets: "https://api.x.com/2/tweets",
  tweet: (id: string) => `https://api.x.com/2/tweets/${id}?tweet.fields=public_metrics`,
};
export const X_SEGMENT = 4 * MB;

async function xPost(mediaId: string, i: Pick<UploadInput, "meta" | "token" | "profile" | "fetchImpl" | "beforePost">): Promise<UploadOutcome> {
  const f = i.fetchImpl ?? fetch;
  await i.beforePost?.();
  let r: Response;
  try {
    r = await f(XAPI.tweets, { method: "POST", headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: withTags(i.meta.description, i.meta.hashtags), media: { media_ids: [mediaId] } }) });
  } catch {
    throw new PublishError("Lost the connection while X was creating the post; check your X profile before retrying.", false, true);
  }
  if (!r.ok) await fail("x", r, "post");
  const id = ((await r.json().catch(() => null)) as { data?: { id?: string } } | null)?.data?.id;
  if (!id || !/^\d+$/.test(id)) throw new PublishError("X answered without a post id; check your X profile before retrying.", false, true);
  return { kind: "published", platformId: id, url: i.profile.handle ? `https://x.com/${handle(i.profile.handle)}/status/${id}` : `https://x.com/i/status/${id}` };
}

async function xUpload(i: UploadInput): Promise<UploadOutcome> {
  const f = i.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${i.token}` };
  const init = (await (await call("x", f, "upload start", XAPI.init, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ media_type: "video/mp4", total_bytes: i.blob.size, media_category: "tweet_video" }) })).json()) as { data?: { id?: string } };
  const id = init.data?.id;
  if (!id) throw new PublishError("X returned no media id.", true);
  const parts = Math.max(1, Math.ceil(i.blob.size / X_SEGMENT));
  for (let k = 0; k < parts; k++) {
    const form = new FormData();
    form.append("segment_index", String(k));
    form.append("media", i.blob.slice(k * X_SEGMENT, (k + 1) * X_SEGMENT), "clip.mp4");
    await call("x", f, `upload part ${k + 1}/${parts}`, XAPI.append(id), { method: "POST", headers: auth, body: form });
    i.onProgress?.((k + 1) / parts);
  }
  const fin = (await (await call("x", f, "upload finish", XAPI.finalize(id), { method: "POST", headers: auth })).json()) as { data?: { processing_info?: { state?: string } } };
  const st = fin.data?.processing_info?.state;
  if (st === "failed") throw new PublishError("X couldn't process the video.", false);
  if (st && st !== "succeeded") return { kind: "confirming", ref: `media:${id}`, note: "X is processing the video." };
  return xPost(id, i);
}

async function xConfirm(ref: string, i: Pick<UploadInput, "meta" | "token" | "profile" | "fetchImpl" | "beforePost">): Promise<ConfirmOutcome> {
  const f = i.fetchImpl ?? fetch;
  const id = ref.replace(/^media:/, "");
  const r = await call("x", f, "processing status", XAPI.status(id), { headers: { authorization: `Bearer ${i.token}` } });
  const p = ((await r.json()) as { data?: { processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } } }).data?.processing_info;
  if (!p || p.state === "succeeded") {
    const out = await xPost(id, i);
    return out.kind === "published" ? out : { kind: "pending", note: out.note };
  }
  if (p.state === "failed") return { kind: "failed", reason: `X couldn't process the video${p.error?.message ? `: ${p.error.message}` : ""}.` };
  return { kind: "pending", note: "X is processing the video.", afterSec: p.check_after_secs };
}

// --- common --------------------------------------------------------------------------------------

export function upload(dest: Destination, i: UploadInput): Promise<UploadOutcome> {
  return dest === "youtube" ? youtubeUpload(i) : dest === "tiktok" ? tiktokUpload(i) : xUpload(i);
}

export function confirm(dest: Destination, ref: string, i: Pick<UploadInput, "meta" | "token" | "profile" | "fetchImpl" | "beforePost">): Promise<ConfirmOutcome> {
  const f = i.fetchImpl ?? fetch;
  return dest === "youtube" ? youtubeConfirm(ref, i.token, f) : dest === "tiktok" ? tiktokConfirm(ref, i.token, i.profile, f) : xConfirm(ref, i);
}

const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Real numbers from the platform for a published clip (none are estimated). */
export async function fetchMetrics(dest: Destination, platformId: string, token: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<Metrics | null> {
  const at = now.toISOString();
  if (dest === "youtube") {
    const r = await call("youtube", fetchImpl, "statistics", `${YT.videos}?part=statistics&id=${encodeURIComponent(platformId)}`, { headers: { authorization: `Bearer ${token}` } });
    const s = ((await r.json()) as { items?: { statistics?: Record<string, string> }[] }).items?.[0]?.statistics;
    return s ? { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), shares: null, fetched_at: at } : null;
  }
  if (dest === "x") {
    const r = await call("x", fetchImpl, "metrics", XAPI.tweet(platformId), { headers: { authorization: `Bearer ${token}` } });
    const m = ((await r.json()) as { data?: { public_metrics?: Record<string, number> } }).data?.public_metrics;
    return m ? { views: num(m.impression_count), likes: num(m.like_count), comments: num(m.reply_count), shares: num((m.retweet_count ?? 0) + (m.quote_count ?? 0)), fetched_at: at } : null;
  }
  if (!/^\d+$/.test(platformId)) return null; // private TikTok posts have no public id to look up
  const r = await call("tiktok", fetchImpl, "metrics", TT.query, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ filters: { video_ids: [platformId] } }) });
  const v = ((await tiktokJson(r, "metrics")).videos as Record<string, unknown>[] | undefined)?.[0];
  return v ? { views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count), fetched_at: at } : null;
}
