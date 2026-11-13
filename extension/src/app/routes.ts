import { Clapperboard, Compass, LayoutDashboard, Radio, Settings, Sparkles, Users, type LucideIcon } from "lucide-react";

export const ROUTES = [
  "/overview",
  "/discover",
  "/streamers",
  "/monitoring",
  "/highlights",
  "/clips",
  "/settings",
] as const;

export type Route = (typeof ROUTES)[number];

export const NAV: readonly { route: Route; label: string; icon: LucideIcon; description: string }[] = [
  { route: "/overview", label: "Overview", icon: LayoutDashboard, description: "Your monitoring at a glance" },
  { route: "/discover", label: "Discover", icon: Compass, description: "Find Twitch and Kick streamers" },
  { route: "/streamers", label: "My Streamers", icon: Users, description: "Your watchlist" },
  { route: "/monitoring", label: "Live Monitoring", icon: Radio, description: "Active sessions and signals" },
  { route: "/highlights", label: "Highlights", icon: Sparkles, description: "Detected moments to review" },
  { route: "/clips", label: "Clip Library", icon: Clapperboard, description: "Created and exported clips" },
  { route: "/settings", label: "Settings", icon: Settings, description: "Connections, detection and privacy" },
];
