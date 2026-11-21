import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { DESTINATION_LABEL, DESTINATIONS, RIGHTS_LABEL, type Destination, type Rights, type RightsStatus } from "@/local/rights";

export const RIGHTS_TONE: Record<RightsStatus, BadgeTone> = { unknown: "neutral", analysis: "accent", processing: "accent", publishing: "live" };

export function RightsBadge({ rights }: { rights: Pick<Rights, "status"> | null | undefined }) {
  const s = rights?.status ?? "unknown";
  return <Badge tone={RIGHTS_TONE[s]}>{RIGHTS_LABEL[s]}</Badge>;
}

export interface RightsInput {
  status: RightsStatus;
  evidence: string;
  destinations: Destination[];
  confirmed: boolean;
}

/**
 * You state what you're allowed to do, with evidence. StreamHunter stores it with the date and
 * enforces it; it can't verify it for you.
 */
export function RightsForm({
  initial,
  minimum = "unknown",
  submitLabel = "Save rights",
  onSubmit,
  children,
}: {
  initial?: Partial<Rights>;
  minimum?: RightsStatus;
  submitLabel?: string;
  onSubmit: (r: RightsInput) => Promise<unknown>;
  children?: React.ReactNode;
}) {
  const [status, setStatus] = useState<RightsStatus>(initial?.status && initial.status !== "unknown" ? initial.status : minimum === "unknown" ? "unknown" : minimum);
  const [evidence, setEvidence] = useState(initial?.evidence ?? "");
  const [destinations, setDestinations] = useState<Destination[]>(initial?.destinations ?? []);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const levels = (["unknown", "analysis", "processing", "publishing"] as RightsStatus[]).filter((l) => minimum === "unknown" || l !== "unknown");

  return (
    <form
      className="space-y-2 rounded-lg border border-ink-700 bg-ink-850 p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        onSubmit({ status, evidence, destinations, confirmed })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save"))
          .finally(() => setBusy(false));
      }}
    >
      {children}
      <label className="block">
        <span className="text-fg-muted">What you're allowed to do</span>
        <Select aria-label="Rights level" value={status} onChange={(e) => setStatus(e.target.value as RightsStatus)} className="mt-1 w-full">
          {levels.map((l) => (
            <option key={l} value={l}>
              {RIGHTS_LABEL[l]}
            </option>
          ))}
        </Select>
      </label>
      {status !== "unknown" && (
        <>
          <label className="block">
            <span className="text-fg-muted">Evidence (link, licence, written permission, "my own channel"…)</span>
            <Input aria-label="Rights evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} className="mt-1 w-full" placeholder="e.g. Creator's clipping programme: https://…" />
          </label>
          {status === "publishing" && (
            <fieldset className="flex flex-wrap gap-3">
              <legend className="mb-1 text-fg-muted">Allowed destinations</legend>
              {DESTINATIONS.map((d) => (
                <label key={d} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={destinations.includes(d)} onChange={(e) => setDestinations(e.target.checked ? [...destinations, d] : destinations.filter((x) => x !== d))} />
                  {DESTINATION_LABEL[d]}
                </label>
              ))}
            </fieldset>
          )}
          <label className="flex items-start gap-1.5">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span>I confirm I have these rights. Finding or recording a video doesn't give the right to republish it.</span>
          </label>
        </>
      )}
      {error && <p className="text-danger">{error}</p>}
      <Button type="submit" size="sm" variant="secondary" icon={<ShieldCheck className="size-3.5" />} loading={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
