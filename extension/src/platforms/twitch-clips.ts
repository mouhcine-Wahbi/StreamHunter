import { getCredentials } from "./credentials";
import { PlatformError, requestJson } from "./http";
import { CLIPS_SCOPE, getTwitchUser } from "./twitch-user";

/**
 * Optional native Twitch clip (Helix "Create Clip"). Twitch cuts it from its own copy of the live
 * stream around the moment of the call, on the signed-in editor's account; it is public on Twitch
 * like any clip. Off by default (Settings → Clips).
 */
export async function createTwitchClip(broadcasterId: string): Promise<{ id: string; editUrl: string; url: string }> {
  const [user, creds] = await Promise.all([getTwitchUser(), getCredentials()]);
  if (!creds.twitch) throw new PlatformError("twitch", "not_configured", "Twitch is not set up.");
  if (!user) throw new PlatformError("twitch", "unauthorized", "Sign in with Twitch to create Twitch clips.");
  if (!user.scopes.includes(CLIPS_SCOPE)) throw new PlatformError("twitch", "unauthorized", "Sign in with Twitch again to allow creating clips.");
  const res = await requestJson<{ data?: { id: string; edit_url: string }[] }>(
    "twitch",
    `https://api.twitch.tv/helix/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    { method: "POST", headers: { Authorization: `Bearer ${user.token}`, "Client-Id": creds.twitch.clientId } },
  );
  const clip = res.data?.[0];
  if (!clip) throw new PlatformError("twitch", "http", "Twitch did not create a clip (the stream may be offline or clips are disabled).");
  return { id: clip.id, editUrl: clip.edit_url, url: `https://clips.twitch.tv/${clip.id}` };
}
