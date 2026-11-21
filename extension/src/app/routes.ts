import { BarChart3, Clapperboard, Compass, HeartPulse, LayoutDashboard, Radio, Send, Settings, Smartphone, Sparkles, Telescope, Twitter, Users, type LucideIcon } from "lucide-react";

export const ROUTES = [
  "/overview",
  "/discover",
  "/streamers",
  "/monitoring",
  "/highlights",
  "/clips",
  "/content",
  "/shorts",
  "/xclips",
  "/studio",
  "/performance",
  "/health",
  "/settings",
] as const;

export type Route = (typeof ROUTES)[number];

export const NAV: readonly { route: Route; label: string; icon: LucideIcon; description: string }[] = [
  { route: "/overview", label: "Overview", icon: LayoutDashboard, description: "Your monitoring at a glance" },
  { route: "/streamers", label: "My Creators", icon: Users, description: "Your creators, live status, priority and rights" },
  { route: "/discover", label: "Find Creators", icon: Compass, description: "Find Twitch, Kick and YouTube creators" },
  { route: "/monitoring", label: "Live Monitoring", icon: Radio, description: "Approvals, recording slots and the queue" },
  { route: "/content", label: "Content Discovery", icon: Telescope, description: "Creator uploads, trending and keywords" },
  { route: "/highlights", label: "Clip Queue", icon: Sparkles, description: "Detected moments and clip processing" },
  { route: "/clips", label: "Clip Library", icon: Clapperboard, description: "Every clip, downloadable" },
  { route: "/shorts", label: "Short-form Clips", icon: Smartphone, description: "Vertical 9:16 for YouTube Shorts and TikTok" },
  { route: "/xclips", label: "X Clips", icon: Twitter, description: "Native landscape for X" },
  { route: "/studio", label: "Publishing Studio", icon: Send, description: "Metadata, approvals and publishing" },
  { route: "/performance", label: "Performance", icon: BarChart3, description: "Numbers the platforms report" },
  { route: "/health", label: "System Health", icon: HeartPulse, description: "Load, storage, connectivity and recovery" },
  { route: "/settings", label: "Settings", icon: Settings, description: "Connections, detection and privacy" },
];
