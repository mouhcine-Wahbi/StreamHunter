/**
 * Settings → Companion (4.0): the optional local program that runs FFmpeg, Whisper, yt-dlp and
 * Remotion on this computer. StreamHunter works without it; editing features need it.
 */
import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useAction } from "@/hooks/useAction";
import { useStorageValue } from "@/hooks/useStorageValue";
import { COMPANION_KEY, type CompanionState, type CompanionStatus } from "@/companion/client";
import { sendRequest } from "@/services/runtime";
import { formatBytes, formatRelative } from "@/utils/format";
import { Section } from "./sections";

export const COMPANION_LABEL: Record<CompanionState, string> = {
  connected: "Connected",
  no_permission: "Permission needed",
  not_installed: "Not installed",
  forbidden: "Installed for another extension ID",
  error: "Problem",
};
export const COMPANION_TONE: Record<CompanionState, BadgeTone> = { connected: "live", no_permission: "warn", not_installed: "neutral", forbidden: "warn", error: "danger" };

const TOOL_LABEL: Record<string, string> = { ffmpeg: "FFmpeg", ffprobe: "FFprobe", whisper: "Whisper", "yt-dlp": "yt-dlp", deno: "Deno", remotion: "Remotion" };

function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      icon={done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        )
      }
    />
  );
}

export function CompanionSection() {
  const status = useStorageValue<CompanionStatus>(COMPANION_KEY);
  const id = chrome.runtime.id;
  const command = `node install.mjs --extension-id ${id}`;
  const check = useAction(async () => {
    await sendRequest({ type: "companion/check" });
  });
  const allow = useAction(async () => {
    // Must run in this click: Chrome shows its permission prompt.
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (granted) await sendRequest({ type: "companion/check" });
  });
  const state = status?.state;
  return (
    <Section
      id="companion"
      title="Companion"
      description="An optional program on this computer that runs FFmpeg, Whisper, yt-dlp and Remotion for automatic editing and the YouTube Video Clipper. Chrome starts it when StreamHunter needs it and it stops when Chrome disconnects. It only works inside its own folder, only answers this extension, and nothing leaves this computer. Everything else in StreamHunter works without it."
    >
      <div className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" aria-label={`Companion: ${state ? COMPANION_LABEL[state] : "Not checked yet"}`}>
            <Badge tone={state ? COMPANION_TONE[state] : "neutral"}>{state ? COMPANION_LABEL[state] : "Not checked yet"}</Badge>
          </span>
          {status?.version && <span className="text-fg-muted">version {status.version} · Node {status.node}</span>}
          {status && <span className="text-fg-subtle">checked {formatRelative(status.checked_at)}</span>}
          {state === "no_permission" || !state ? (
            <Button size="sm" variant="secondary" loading={allow.pending} onClick={() => void allow.run()}>
              Allow and connect
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={check.pending} onClick={() => void check.run()}>
              Check again
            </Button>
          )}
        </div>
        {status?.message && <p className={state === "error" ? "text-danger" : "text-fg-muted"}>{status.message}</p>}
        {(check.error || allow.error) && <p className="text-danger">{check.error ?? allow.error}</p>}

        {state !== "connected" && (
          <div className="space-y-1 rounded-md border border-border p-2">
            <p className="font-medium text-fg">Set it up (once per Chrome profile)</p>
            <ol className="list-decimal space-y-1 pl-4 text-fg-muted">
              <li>Install the tools with Homebrew: <code className="text-fg">brew install ffmpeg openai-whisper yt-dlp deno node</code> (Node 22 or later).</li>
              <li>
                In a Terminal, open the <code className="text-fg">companion</code> folder of StreamHunter and run:
                <span className="mt-1 flex items-center gap-1">
                  <code className="rounded bg-ink-850 px-1.5 py-1 text-fg" aria-label="Install command">
                    {command}
                  </code>
                  <CopyText text={command} label="Copy install command" />
                </span>
              </li>
              <li>Come back here and click {state === "no_permission" || !state ? "Allow and connect" : "Check again"}.</li>
            </ol>
            <p className="text-fg-subtle">
              This extension's ID: <code className="text-fg">{id}</code>. To remove the companion later: <code className="text-fg">node install.mjs --uninstall</code>.
            </p>
          </div>
        )}

        {status?.tools && (
          <table className="w-full text-left" aria-label="Companion tools">
            <thead className="text-fg-subtle">
              <tr>
                <th className="py-1 font-normal">Tool</th>
                <th className="font-normal">Version</th>
                <th className="font-normal">Needed for</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(status.tools).map((t) => (
                <tr key={t.name} className="border-t border-border align-top">
                  <td className="whitespace-nowrap py-1 pr-2 text-fg">
                    {t.ok ? "✓" : "✗"} {TOOL_LABEL[t.name] ?? t.name}
                  </td>
                  <td className="pr-2">
                    {t.version ?? "—"}
                    {!t.ok && <span className="block text-warn">{t.detail} · needs {t.min}</span>}
                    {t.name === "ffmpeg" && t.found && <span className="block text-fg-subtle">{t.videotoolbox ? "hardware encoding (VideoToolbox)" : "no hardware encoder"}</span>}
                  </td>
                  <td className="text-fg-muted">{t.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status?.work_dir && (
          <div className="space-y-1">
            <p className="text-fg-muted">
              Work folder <code className="text-fg">{status.work_dir}</code> · uses {formatBytes(status.used_bytes ?? 0)} · {formatBytes(status.free_bytes ?? 0)} free on the disk
            </p>
            <WorkFolderCleanup />
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * 4.7: the companion cleans its work folder at every start; this runs the same clean-up now
 * (leftover temporary files, finished jobs older than a week, files no job uses after a day).
 */
function WorkFolderCleanup() {
  const [notice, setNotice] = useState<string | null>(null);
  const clean = useAction(async () => {
    const r = await sendRequest({ type: "companion/cleanup" });
    const n = r.removed.tmp + r.removed.jobs + r.removed.files;
    setNotice(n ? `Removed ${n} leftover item${n === 1 ? "" : "s"} (${formatBytes(r.removed.bytes)}). The folder now uses ${formatBytes(r.used_bytes)}.` : `Nothing to remove. The folder uses ${formatBytes(r.used_bytes)}.`);
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" loading={clean.pending} onClick={() => void clean.run()}>
        Clean up work folder
      </Button>
      {notice && <span className="text-fg-muted">{notice}</span>}
      {clean.error && <span className="text-danger">{clean.error}</span>}
    </div>
  );
}
