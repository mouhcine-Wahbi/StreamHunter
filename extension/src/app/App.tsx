import { useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useMonitoring } from "@/hooks/useMonitoring";
import { OverviewPage } from "@/pages/overview/OverviewPage";
import { DiscoverPage } from "@/pages/discover/DiscoverPage";
import { StreamersPage } from "@/pages/streamers/StreamersPage";
import { MonitoringPage } from "@/pages/monitoring/MonitoringPage";
import { HighlightsPage } from "@/pages/highlights/HighlightsPage";
import { ClipsPage } from "@/pages/clips/ClipsPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { NAV, ROUTES, type Route } from "./routes";

export function App() {
  const { route, navigate } = useHashRoute<Route>(ROUTES, "/overview");
  const monitoring = useMonitoring();

  useEffect(() => {
    const label = NAV.find((n) => n.route === route)?.label;
    document.title = label ? `${label} · StreamHunter` : "StreamHunter";
  }, [route]);

  let page;
  switch (route) {
    case "/overview":
      page = <OverviewPage monitoring={monitoring} />;
      break;
    case "/discover":
      page = <DiscoverPage />;
      break;
    case "/streamers":
      page = <StreamersPage onDiscover={() => navigate("/discover")} />;
      break;
    case "/monitoring":
      page = <MonitoringPage monitoring={monitoring} />;
      break;
    case "/highlights":
      page = <HighlightsPage />;
      break;
    case "/clips":
      page = <ClipsPage />;
      break;
    case "/settings":
      page = <SettingsPage />;
      break;
  }

  return (
    <div data-surface="workspace" className="flex h-screen overflow-hidden bg-[radial-gradient(1200px_600px_at_80%_-10%,#8b5cf614,transparent)]">
      <Sidebar route={route} onNavigate={navigate} status={monitoring.state.status} />
      <main className="flex-1 overflow-y-auto">
        <div key={route} className="mx-auto max-w-6xl px-8 py-8">
          {page}
        </div>
      </main>
    </div>
  );
}
