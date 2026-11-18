import { getSettings } from "@/store/storage";
import { useEffect, useState } from "react";
import { Link2, Plug, Unplug } from "lucide-react";
import { ApiStateView } from "@/components/ApiStateView";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { getCredentials, setCredentials, type AppPlatform, type PlatformCredentials } from "@/platforms/credentials";
import type { Capability, Feature } from "@/platforms/adapter";
import { getTwitchUser, redirectUrl, signInWithTwitch, signOutOfTwitch, TWITCH_USER_KEY, type TwitchUser } from "@/platforms/twitch-user";
import { onStorageKeyChange } from "@/store/storage";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useAction } from "@/hooks/useAction";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { PLATFORM_LABEL, type Platform } from "@/types/api";

interface PlatformCapabilities {
  platform: Platform;
  label: string;
  configured: boolean;
  auth_message: string;
  capabilities: Record<Feature, Capability>;
}

const SUPPORT_TONE: Record<Capability["support"], BadgeTone> = { supported: "live", partial: "warn", unsupported: "neutral" };
const VERIFIED_LABEL: Record<Capability["verified"], string> = {
  verified: "tested for real",
  simulated: "tested against documented responses",
  untested: "not yet tested",
};
const FEATURE_LABEL: Record<Feature, string> = {
  search: "Search",
  lookup: "Add by name/link",
  live_status: "Live status",
  discover_live: "Live now list",
  viewers: "Viewer count",
  chat: "Chat signals",
  capture: "Video recording",
  native_clips: "Native clips",
};

const APP_HELP: Record<Platform, { url: string; label: string; redirect: string }> = {
  twitch: { url: "https://dev.twitch.tv/console/apps", label: "dev.twitch.tv/console", redirect: "OAuth redirect URL: the one shown under Chat below" },
  kick: { url: "https://kick.com/settings/developer", label: "kick.com/settings/developer", redirect: "Redirect URL: any (e.g. http://localhost)" },
  youtube: {
    url: "https://console.cloud.google.com/apis/credentials",
    label: "console.cloud.google.com",
    redirect: "enable YouTube Data API v3, then Create credentials → API key",
  },
};

/** YouTube: an API key from the editor's own Google Cloud project (public data, no sign-in). */
function YouTubeKeyForm({ onChanged }: { onChanged: () => void }) {
  const client = useApiClient();
  const [saved, setSaved] = useState(false);
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => void getCredentials().then((c) => setSaved(Boolean(c.youtube))), []);
  const save = useAction(async () => {
    setNotice(null);
    const next = await setCredentials("youtube", { apiKey: key });
    if (!next.youtube) throw new Error("That doesn't look like an API key (letters, digits, - and _).");
    setSaved(true);
    setKey("");
    // Prove it works with a 1-unit call (channels.list by handle).
    await client.get(`/api/v1/streamers/search?platform=youtube&username=${encodeURIComponent("@YouTube")}`);
    setNotice("Saved and working: YouTube answered.");
    onChanged();
  });
  const remove = useAction(async () => {
    await setCredentials("youtube", null);
    setSaved(false);
    setNotice("Removed from this computer.");
    onChanged();
  });
  return (
    <div className="mt-4 space-y-2 border-t border-ink-700 pt-3 text-xs">
      <p className="text-fg-muted">
        A free API key from your own Google Cloud project at{" "}
        <a className="text-accent underline" href={APP_HELP.youtube.url} target="_blank" rel="noreferrer">
          {APP_HELP.youtube.label}
        </a>{" "}
        ({APP_HELP.youtube.redirect}). Public data only, so no Google sign-in. Restrict the key to the YouTube Data API. Stored only in this browser.
      </p>
      <Input
        aria-label="youtube API key"
        placeholder={saved ? "API key (saved; enter again to change)" : "API key"}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={save.pending} icon={<Plug className="size-3.5" />} onClick={() => void save.run()}>
          {saved ? "Update and test" : "Save and test"}
        </Button>
        {saved && (
          <Button size="sm" variant="ghost" loading={remove.pending} icon={<Unplug className="size-3.5" />} onClick={() => void remove.run()}>
            Remove
          </Button>
        )}
      </div>
      {notice && <p className="text-live">{notice}</p>}
      {(save.error || remove.error) && (
        <p role="alert" className="text-danger">
          {save.error ?? remove.error}
        </p>
      )}
    </div>
  );
}

/** The editor's own developer-app credentials for one platform (kept on this computer only). */
function CredentialsForm({ platform, onChanged }: { platform: Platform; onChanged: () => void }) {
  const client = useApiClient();
  const [creds, setCreds] = useState<PlatformCredentials | null>(null);
  const [clientId, setClientId] = useState("");
  const app = platform as AppPlatform;
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void getCredentials().then((c) => {
      setCreds(c);
      setClientId(c[app]?.clientId ?? "");
    });
  }, [platform]);
  const saved = creds?.[app] ?? null;
  const optionalSecret = platform === "twitch";

  const save = useAction(async () => {
    setNotice(null);
    if (!clientId.trim() || (!secret.trim() && !optionalSecret)) throw new Error("Enter both the client ID and the client secret.");
    // Twitch without a secret: API calls use your Sign in with Twitch token instead (nothing secret is stored).
    const keep = !secret.trim() && saved?.clientId === clientId.trim() ? saved.clientSecret : secret;
    setCreds(await setCredentials(platform, { clientId, clientSecret: keep }));
    setSecret("");
    // Prove it works with one cheap call: the most-watched live channel.
    const live = await client.get<unknown[]>(`/api/v1/discover/live?platform=${platform}&limit=1`);
    setNotice(`Saved and working: ${PLATFORM_LABEL[platform]} answered (${live.length} live channel checked).`);
    onChanged();
  });
  const remove = useAction(async () => {
    setCreds(await setCredentials(platform, null));
    setClientId("");
    setSecret("");
    setNotice("Removed from this computer.");
    onChanged();
  });

  return (
    <div className="mt-4 space-y-2 border-t border-ink-700 pt-3 text-xs">
      <p className="text-fg-muted">
        Your own {PLATFORM_LABEL[platform]} app, created for free at{" "}
        <a className="text-accent underline" href={APP_HELP[platform].url} target="_blank" rel="noreferrer">
          {APP_HELP[platform].label}
        </a>{" "}
        ({APP_HELP[platform].redirect}). Stored only in this browser and sent only to {PLATFORM_LABEL[platform]}.
        {optionalSecret && " The secret is optional: without it, StreamHunter uses your Sign in with Twitch below instead."}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label={`${platform} client ID`} placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        <Input
          aria-label={`${platform} client secret`}
          placeholder={saved?.clientSecret ? "Client secret (saved; enter again to change)" : optionalSecret ? "Client secret (optional)" : "Client secret"}
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={save.pending} icon={<Plug className="size-3.5" />} onClick={() => void save.run()}>
          {saved ? "Update and test" : "Save and test"}
        </Button>
        {saved && (
          <Button size="sm" variant="ghost" loading={remove.pending} icon={<Unplug className="size-3.5" />} onClick={() => void remove.run()}>
            Remove
          </Button>
        )}
      </div>
      {notice && <p className="text-live">{notice}</p>}
      {(save.error || remove.error) && (
        <p role="alert" className="text-danger">
          {save.error ?? remove.error}
        </p>
      )}
    </div>
  );
}

/** Twitch chat needs the editor's own Twitch sign-in (user:read:chat), on top of the app credentials. */
function TwitchChatSignIn({ configured }: { configured: boolean }) {
  const [user, setUser] = useState<TwitchUser | null>(null);
  useEffect(() => {
    void getTwitchUser().then(setUser);
    return onStorageKeyChange(TWITCH_USER_KEY, () => void getTwitchUser().then(setUser));
  }, []);
  const signIn = useAction(async () => setUser(await signInWithTwitch({ clips: (await getSettings()).clips.twitchNativeClips })));
  const signOut = useAction(async () => {
    await signOutOfTwitch();
    setUser(null);
  });
  return (
    <div className="mt-4 space-y-2 border-t border-ink-700 pt-3 text-xs">
      <p className="font-medium text-fg">Chat (for chat-based highlights)</p>
      {user ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-fg-muted">
            Signed in as <span className="text-fg">{user.login}</span>. StreamHunter reads chat of your live Twitch streamers.
          </span>
          <Button size="sm" variant="ghost" loading={signOut.pending} onClick={() => void signOut.run()}>
            Sign out
          </Button>
        </div>
      ) : (
        <>
          <p className="text-fg-muted">
            Twitch only shares chat with a signed-in account. Add this redirect URL to your Twitch app first:{" "}
            <code className="rounded bg-ink-800 px-1 py-0.5 text-fg">{redirectUrl()}</code>
          </p>
          <Button size="sm" variant="secondary" disabled={!configured} loading={signIn.pending} onClick={() => void signIn.run()}>
            Sign in with Twitch
          </Button>
        </>
      )}
      {(signIn.error || signOut.error) && (
        <p role="alert" className="text-danger">
          {signIn.error ?? signOut.error}
        </p>
      )}
    </div>
  );
}

export function PlatformConnections() {
  const query = useApiQuery<PlatformCapabilities[]>("/api/v1/platforms/capabilities");
  return (
    <ApiStateView query={query} feature="platform connections" compact>
      {(platforms) => (
        <div className="space-y-3">
          {platforms.map((p) => (
            <Card key={p.platform} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link2 className="size-4 text-fg-subtle" />
                  <PlatformBadge platform={p.platform} />
                </div>
                <Badge tone={p.configured ? "live" : "warn"}>
                  {p.configured ? (p.platform === "youtube" ? "API key saved" : "app credentials saved") : "not configured"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-fg-subtle">{p.auth_message}</p>
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {(Object.entries(p.capabilities) as [Feature, Capability][]).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-2 text-xs" title={`${v.note} (${VERIFIED_LABEL[v.verified]})`}>
                    <dt className="text-fg-muted">{FEATURE_LABEL[k]}</dt>
                    <dd className="flex items-center gap-1">
                      <Badge tone={SUPPORT_TONE[v.support]}>{v.support}</Badge>
                      {v.support !== "unsupported" && v.verified !== "verified" && (
                        <span className="text-[10px] text-fg-subtle">{v.verified === "simulated" ? "simulated" : "untested"}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {p.platform === "youtube" ? <YouTubeKeyForm onChanged={query.reload} /> : <CredentialsForm platform={p.platform} onChanged={query.reload} />}
              {p.platform === "twitch" && <TwitchChatSignIn configured />}
            </Card>
          ))}
          <p className="text-[11px] text-fg-subtle">
            "simulated": checked against each platform's documented responses, not yet against the real service with your credentials. "untested":
            not checked yet. Hover a row for details.
          </p>
        </div>
      )}
    </ApiStateView>
  );
}
