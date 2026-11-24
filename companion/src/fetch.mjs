/**
 * 4.6: yt-dlp, opt-in, for a YouTube video you own or have written permission to download.
 *
 * Only an 11-character video id is accepted; the URL is built here. yt-dlp runs with
 * --ignore-config (no config file can add options), --no-cookies and --no-cookies-from-browser, and
 * never with a login, netrc or client certificate. The video's availability is checked first and
 * anything that isn't plainly public or unlisted is refused: private, members-only, paid,
 * sign-in required, age-restricted, live or upcoming, DRM. A refusal is final; nothing is retried
 * another way. The extension also asks for your confirmation per video.
 */

export const VIDEO_ID = /^[\w-]{11}$/;
export const FETCH_LIMITS = { maxDurationSec: 4 * 3600, maxFilesize: "4G", maxHeight: 1080 };

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

/** Options that keep yt-dlp from using any saved login, cookies or config file. */
const SAFE = ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist"];
/** Options that must never appear (checked in the tests and before every run). */
export const FORBIDDEN = [/^--cookies/, /^--username$/, /^-u$/, /^--password$/, /^-p$/, /^--netrc/, /^-n$/, /^--video-password$/, /^--client-certificate/, /^--ap-/, /^--add-headers?$/, /^--remote-components$/];

function runtime(deno) {
  return deno ? ["--js-runtimes", `deno:${deno}`] : [];
}

export function checkArgs({ id, deno }) {
  if (!VIDEO_ID.test(id)) throw new Error("Invalid video id");
  return [watchUrl(id), ...SAFE, ...runtime(deno), "--dump-single-json", "--no-warnings"];
}

export function downloadArgs({ id, out, ffmpeg, deno }) {
  if (!VIDEO_ID.test(id)) throw new Error("Invalid video id");
  const h = FETCH_LIMITS.maxHeight;
  return [
    watchUrl(id),
    ...SAFE,
    ...runtime(deno),
    "--format",
    `bv*[height<=${h}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]`,
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    ffmpeg,
    "--max-filesize",
    FETCH_LIMITS.maxFilesize,
    "--no-mtime",
    "--newline",
    "--abort-on-error",
    "--output",
    out,
  ];
}

export function assertSafe(args) {
  const bad = args.filter((a) => FORBIDDEN.some((r) => r.test(a)));
  if (bad.length) throw new Error(`Refusing to run yt-dlp with ${bad.join(" ")}`);
  return args;
}

/**
 * yt-dlp's JSON (documented fields: availability, live_status, is_live, age_limit, duration, and
 * has_drm on formats) → why it is refused, or null when it may be fetched.
 */
export function refusal(info, id) {
  if (!info || typeof info !== "object") return "yt-dlp didn't return the video's details.";
  if (info.id !== id) return "yt-dlp returned a different video than the one you approved.";
  const a = info.availability ?? null;
  if (a === "private") return "The video is private.";
  if (a === "premium_only") return "The video needs a paid subscription (YouTube Premium or a rental).";
  if (a === "subscriber_only") return "The video is for channel members only.";
  if (a === "needs_auth") return "The video needs a sign-in. StreamHunter never signs in for downloads.";
  if (a !== "public" && a !== "unlisted") return "YouTube didn't say the video is public or unlisted, so it isn't fetched.";
  const live = info.live_status ?? (info.is_live ? "is_live" : null);
  if (live === "is_live" || live === "is_upcoming" || live === "post_live") return "The video is a live stream (or not finished processing). Use it once it is a regular video.";
  if (Number(info.age_limit) > 0) return "The video is age-restricted. StreamHunter doesn't download age-restricted videos.";
  if (info._has_drm || (info.formats ?? []).some((f) => f?.has_drm)) return "The video is protected (DRM). StreamHunter never works around protection.";
  if (!Number.isFinite(info.duration) || info.duration <= 0) return "The video's length is unknown.";
  if (info.duration > FETCH_LIMITS.maxDurationSec) return `The video is longer than ${FETCH_LIMITS.maxDurationSec / 3600} hours.`;
  return null;
}

/** yt-dlp's own error, in a sentence (sign-in, unavailable, members-only…). Never retried. */
export function ytdlpError(stderr) {
  const line = String(stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
    .at(-1);
  return line ? line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{11}:\s*)?/, "").slice(0, 300) : null;
}
