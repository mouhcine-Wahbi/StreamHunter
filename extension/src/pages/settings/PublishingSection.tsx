/**
 * Settings → Publishing (3.0): your own app per destination, connecting the account, and the
 * publishing rules (automatic publishing, destinations, daily limits, privacy, retries).
 */
import { useEffect, useState } from "react";
import { Field, Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { connect, disconnect, listAccounts, originsFor, redirectUri, setAppConfig, type AccountView } from "@/publishing/accounts";
import { DESTINATION_LABEL, DESTINATIONS, type Destination } from "@/local/rights";
import { sendRequest } from "@/services/runtime";
import type { DeepPartial, Settings } from "@/types/settings";
import { NumberField, Section } from "./sections";

const APP_HINT: Record<Destination, string> = {
  youtube: "Google Cloud → OAuth client ID of type “Web application” with the YouTube Data API v3 enabled. No secret is needed.",
  tiktok: "TikTok for Developers → your app's client key (Login Kit for Web + Content Posting API, Direct Post). The secret stays on your token server.",
  x: "X Developer Console → OAuth 2.0 client ID of a Native App or Single page App (public client). No secret is needed.",
};

function AccountRow({ view, onChanged }: { view: AccountView; onChanged: (v: AccountView) => void }) {
  const d = view.destination;
  const [clientId, setClientId] = useState(view.clientId ?? "");
  const [server, setServer] = useState(view.tokenServer ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (f: () => Promise<AccountView>, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      onChanged(await f());
      if (done) setMsg(done);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(() => setAppConfig(d, { clientId, ...(d === "tiktok" ? { tokenServer: server } : {}) }), "Saved. Now connect the account.");
  const doConnect = () =>
    run(async () => {
      // Chrome asks you once to allow StreamHunter to contact this platform.
      const granted = await chrome.permissions.request({ origins: originsFor(d, { clientId, tokenServer: server }) }).catch(() => false);
      if (!granted) throw new Error(`Chrome didn't allow StreamHunter to contact ${DESTINATION_LABEL[d]}.`);
      const v = await connect(d);
      void sendRequest({ type: "publish/run" }).catch(() => undefined);
      return v;
    }, "Connected.");
  const dirty = clientId !== (view.clientId ?? "") || (d === "tiktok" && server !== (view.tokenServer ?? ""));
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3 text-xs">
      <legend className="flex items-center gap-2 px-1 text-sm font-medium text-fg">
        {DESTINATION_LABEL[d]}
        {view.connected ? <Badge tone={view.problem ? "warn" : "live"}>{view.problem ? "Reconnect needed" : `Connected as ${view.name}`}</Badge> : <Badge>Not connected</Badge>}
      </legend>
      <p className="text-fg-subtle">{APP_HINT[d]}</p>
      <label className="block">
        <span className="text-fg-muted">{d === "tiktok" ? "Client key" : "Client ID"}</span>
        <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-96" autoComplete="off" aria-label={`${DESTINATION_LABEL[d]} ${d === "tiktok" ? "client key" : "client ID"}`} />
      </label>
      {d === "tiktok" && (
        <label className="block">
          <span className="text-fg-muted">Your token server (https)</span>
          <Input value={server} onChange={(e) => setServer(e.target.value)} className="w-96" placeholder="https://tokens.example.com/tiktok" aria-label="TikTok token server" />
        </label>
      )}
      <p className="text-fg-subtle">
        Redirect URI to register: <code className="select-all text-fg">{redirectUri()}</code>
      </p>
      {view.problem && <p className="text-warn">{view.problem}</p>}
      {msg && <p className="text-fg-muted">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!dirty || !clientId.trim()} loading={busy} onClick={() => void save()}>
          Save app
        </Button>
        <Button size="sm" disabled={!view.configured || dirty} loading={busy} onClick={() => void doConnect()}>
          {view.connected ? "Connect again" : "Connect account"}
        </Button>
        {view.connected && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => disconnect(d), "Disconnected.")}>
            Disconnect
          </Button>
        )}
      </div>
    </fieldset>
  );
}

export function PublishingSection({ s, update }: { s: Settings; update: (patch: DeepPartial<Settings>) => Promise<unknown> }) {
  const p = s.publishing;
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  useEffect(() => void listAccounts().then(setAccounts), []);
  return (
    <Section
      id="publishing"
      title="Publishing"
      description="Your own accounts and apps; StreamHunter never stores a secret. High-potential clips you have publishing rights for are published automatically when every check passes; medium waits for your approval; low is never automatic. A post counts as published only when the platform confirms it."
    >
      <Field inline label="Automatic publishing" hint="Off: every job waits for your approval in Publishing Studio.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Automatic publishing" checked={p.autoPublish} onChange={(autoPublish) => void update({ publishing: { autoPublish } })} />}
      </Field>
      {DESTINATIONS.map((d) => (
        <Field key={d} inline label={DESTINATION_LABEL[d]} hint="On/off and posts per day (resets at local midnight).">
          {({ id, describedBy }) => (
            <div className="flex items-center gap-3">
              <Switch id={id} aria-describedby={describedBy} label={`Publish to ${DESTINATION_LABEL[d]}`} checked={p.destinations[d].enabled} onChange={(enabled) => void update({ publishing: { destinations: { [d]: { enabled } } } })} />
              <NumberField id={`${id}-limit`} value={p.destinations[d].dailyLimit} min={0} max={100} onCommit={(dailyLimit) => void update({ publishing: { destinations: { [d]: { dailyLimit } } } })} />
            </div>
          )}
        </Field>
      ))}
      <Field inline label="YouTube visibility" hint="Unverified Google projects can only upload privately.">
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} className="w-40" value={p.youtubePrivacy} onChange={(e) => void update({ publishing: { youtubePrivacy: e.target.value as Settings["publishing"]["youtubePrivacy"] } })}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </Select>
        )}
      </Field>
      <Field inline label="TikTok privacy" hint="Must be one TikTok offers for your account. Unaudited TikTok apps: only “Only me”.">
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} className="w-48" value={p.tiktokPrivacy} onChange={(e) => void update({ publishing: { tiktokPrivacy: e.target.value as Settings["publishing"]["tiktokPrivacy"] } })}>
            <option value="SELF_ONLY">Only me</option>
            <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
            <option value="FOLLOWER_OF_CREATOR">Followers</option>
            <option value="PUBLIC_TO_EVERYONE">Everyone</option>
          </Select>
        )}
      </Field>
      <Field inline label="Retries" hint="For network, rate-limit and server errors only (2 min, 4 min, 8 min… up to 1 h).">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={p.maxRetries} min={0} max={10} onCommit={(maxRetries) => void update({ publishing: { maxRetries } })} />}
      </Field>
      <div className="space-y-3 pt-2">
        <h3 className="text-sm font-semibold text-fg">Accounts</h3>
        {accounts?.map((a) => <AccountRow key={a.destination} view={a} onChanged={(v) => setAccounts((xs) => xs!.map((x) => (x.destination === v.destination ? v : x)))} />)}
      </div>
    </Section>
  );
}
