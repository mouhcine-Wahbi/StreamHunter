import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Input } from "@/components/ui/Field";

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
