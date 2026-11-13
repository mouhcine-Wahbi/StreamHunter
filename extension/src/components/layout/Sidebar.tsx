import { NAV, type Route } from "@/app/routes";
import { Logo } from "@/components/Logo";
import { MonitoringStatusPill } from "@/components/monitoring/MonitoringStatusPill";
import type { MonitoringStatus } from "@/types/monitoring";
import { cn } from "@/utils/cn";

export function Sidebar({
  route,
  onNavigate,
  status,
}: {
  route: Route;
  onNavigate: (r: Route) => void;
  status: MonitoringStatus;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-ink-700 bg-ink-950/60">
      <div className="px-4 pt-5 pb-6">
        <Logo />
      </div>
      <nav aria-label="Main" className="flex-1 space-y-0.5 px-2">
        {NAV.map(({ route: r, label, icon: Icon }) => {
          const active = r === route;
          return (
            <a
              key={r}
              href={`#${r}`}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(r);
              }}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active ? "bg-ink-700/70 text-fg" : "text-fg-muted hover:bg-ink-800 hover:text-fg",
              )}
            >
              {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" aria-hidden />}
              <Icon className={cn("size-4", active ? "text-accent" : "text-fg-subtle group-hover:text-fg-muted")} />
              {label}
            </a>
          );
        })}
      </nav>
      <div className="m-3 rounded-xl border border-ink-700 bg-ink-850 p-3">
        <div className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">Monitoring</div>
        <div className="mt-1.5">
          <MonitoringStatusPill status={status} />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-fg-subtle">Runs only while Chrome is open.</p>
      </div>
    </aside>
  );
}
