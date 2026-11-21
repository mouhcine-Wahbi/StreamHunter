import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { LIMITS } from "@/types/settings";

export function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid gap-4 border-b border-ink-700 py-7 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <h2 id={`${id}-title`} className="text-sm font-semibold text-fg">
          {title}
        </h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-fg-muted">{description}</p>}
      </div>
      <div className="max-w-xl space-y-5">{children}</div>
    </section>
  );
}

/** Number input that commits on blur/Enter and shows the clamped value afterwards. */
export function NumberField({
  id,
  value,
  min,
  max,
  onCommit,
  suffix,
  describedBy,
  className,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  suffix?: string;
  describedBy?: string | undefined;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className={cn("relative w-32 shrink-0", className)}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-describedby={describedBy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className={suffix ? "pr-12 tabular" : "tabular"}
      />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-xs text-fg-subtle">{suffix}</span>}
    </div>
  );
}

export function KeywordEditor({
  value,
  onChange,
  label = "Custom reaction phrases",
  hint = `Added to the language packs, e.g. "clip it", "no shot". Up to ${LIMITS.customKeywords.maxItems}.`,
  maxItems = LIMITS.customKeywords.maxItems,
  maxLength = LIMITS.customKeywords.maxLength,
  listLabel = "Custom phrases",
}: {
  value: string[];
  onChange: (v: string[]) => void;
  label?: string;
  hint?: string;
  maxItems?: number;
  maxLength?: number;
  listLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const full = value.length >= maxItems;
  const add = () => {
    const k = draft.trim().slice(0, maxLength);
    if (!k || full) return;
    if (!value.some((v) => v.toLocaleLowerCase() === k.toLocaleLowerCase())) onChange([...value, k]);
    setDraft("");
  };
  return (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              id={id}
              aria-describedby={describedBy}
              value={draft}
              maxLength={maxLength}
              disabled={full}
              placeholder="Type a phrase and press Enter"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button onClick={add} disabled={!draft.trim() || full}>
              Add
            </Button>
          </div>
          {value.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={listLabel}>
              {value.map((k) => (
                <li key={k} className="inline-flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 py-0.5 pr-1 pl-2 text-xs text-fg">
                  {k}
                  <button
                    type="button"
                    aria-label={`Remove ${k}`}
                    onClick={() => onChange(value.filter((v) => v !== k))}
                    className="cursor-pointer rounded p-0.5 text-fg-subtle hover:bg-ink-600 hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}

