import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

const control =
  "h-9 w-full rounded-lg border border-ink-600 bg-ink-900 px-3 text-sm text-fg placeholder:text-fg-subtle " +
  "transition-colors hover:border-ink-500 focus:border-accent focus:outline-none disabled:opacity-50";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, "cursor-pointer pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

/**
 * Label + control + hint/error, wired with ids for accessibility.
 * `children` receives the generated id and describedby id.
 */
export function Field({
  label,
  hint,
  error,
  children,
  inline = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  inline?: boolean;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const describedBy = hint || error ? descId : undefined;
  return (
    <div className={cn(inline ? "flex items-center justify-between gap-6" : "space-y-1.5")}>
      <div className={cn(inline && "min-w-0")}>
        <label htmlFor={id} className="block text-sm font-medium text-fg">
          {label}
        </label>
        {inline && (hint || error) && (
          <p id={descId} className={cn("mt-0.5 text-xs", error ? "text-danger" : "text-fg-muted")}>
            {error ?? hint}
          </p>
        )}
      </div>
      {children({ id, describedBy })}
      {!inline && (hint || error) && (
        <p id={descId} className={cn("text-xs", error ? "text-danger" : "text-fg-muted")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
