/**
 * One discovery run over the sources you enabled, with your filters. Each source fails on its own
 * (a missing key or quota never stops the others) and every problem is reported in plain words.
 */
import { db } from "@/local/db";
import { getCredentials } from "@/platforms/credentials";
import { twitchHelix } from "@/platforms/twitch";
import { quotaUsed, youTubeApi } from "@/platforms/youtube";
import type { HttpDeps } from "@/platforms/http";
import type { Streamer } from "@/types/api";
import type { Settings } from "@/types/settings";
import {
  DISCOVERY_KEY, discoveryError, passesFilters, twitchCategoryClips, twitchFindCategory, twitchTopGames, upsertCandidates,
  youtubeCreatorUploads, youtubeKeyword, youtubeTrending, type DiscoveryRun, type Found,
} from "./discovery";

/** YouTube video categories StreamHunter offers for trending (documented IDs). */
export const YT_CATEGORIES: Record<string, string> = { "": "All", "1": "Film & Animation", "10": "Music", "17": "Sports", "20": "Gaming", "22": "People & Blogs", "23": "Comedy", "24": "Entertainment" };

export interface RunOptions {
  /** Which sources to run (default: all enabled). Keyword YouTube search also needs `keywordYouTube`. */
  sources?: ("creator_uploads" | "trending" | "keyword")[];
  http?: HttpDeps;
  now?: () => Date;
}

export async function runDiscovery(settings: Settings, opts: RunOptions = {}): Promise<DiscoveryRun> {
  const now = opts.now ?? (() => new Date());
  const at = now();
  const d = settings.discovery;
  const want = new Set(opts.sources ?? ["creator_uploads", "trending", "keyword"]);
  const creds = await getCredentials();
  const yt = youTubeApi(opts.http, now);
  const helix = twitchHelix(opts.http);
  const startUnits = await quotaUsed(at);
  const found: Found[] = [];
  const problems: Record<string, string> = {};
  const since = new Date(at.getTime() - Math.max(1, d.maxAgeDays || 7) * 86_400_000).toISOString();

  if (want.has("creator_uploads")) {
    const creators = (await db.all<Streamer>("streamers")).filter((s) => s.platform === "youtube" && s.discovery_enabled !== false && /^UC[\w-]{22}$/.test(s.platform_user_id));
    if (creators.length && creds.youtube) {
      try {
        found.push(...(await youtubeCreatorUploads(yt, creators.map((s) => ({ channelId: s.platform_user_id, name: s.display_name })))));
      } catch (e) {
        problems["YouTube creator uploads"] = discoveryError(e);
      }
    } else if (creators.length) problems["YouTube creator uploads"] = "Add your YouTube API key in Settings → Platforms.";
  }

  if (want.has("trending")) {
    if (creds.youtube) {
      for (const cat of d.youtubeCategories.length ? d.youtubeCategories : [""]) {
        try {
          found.push(...(await youtubeTrending(yt, { regionCode: d.youtubeRegion, categoryId: cat, categoryName: YT_CATEGORIES[cat] ?? "", max: d.perSourceMax })));
        } catch (e) {
          problems[`YouTube trending ${YT_CATEGORIES[cat] ?? cat}`] = discoveryError(e);
        }
      }
    } else problems["YouTube trending"] = "Add your YouTube API key in Settings → Platforms.";
    if (d.twitchTrending && d.twitchTopGames > 0) {
      try {
        for (const g of await twitchTopGames(helix, d.twitchTopGames))
          found.push(...(await twitchCategoryClips(helix, g, since, d.perSourceMax, "trending", `Most-viewed Twitch clips in ${g.name}`)));
      } catch (e) {
        problems["Twitch trending"] = discoveryError(e);
      }
    }
  }

  if (want.has("keyword")) {
    for (const q of d.keywords) {
      try {
        const g = await twitchFindCategory(helix, q);
        if (g) found.push(...(await twitchCategoryClips(helix, g, since, d.perSourceMax, "keyword", `Keyword "${q}": Twitch category ${g.name}`)));
      } catch (e) {
        problems[`Twitch keyword "${q}"`] = discoveryError(e);
      }
      if (d.keywordYouTube && creds.youtube) {
        try {
          found.push(...(await youtubeKeyword(yt, { q, publishedAfter: d.maxAgeDays ? since : null, language: d.language, regionCode: d.youtubeRegion, max: d.perSourceMax })));
        } catch (e) {
          problems[`YouTube keyword "${q}"`] = discoveryError(e);
        }
      }
    }
  }

  const kept = found.filter((f) => passesFilters(f, d, at));
  const { added, updated } = await upsertCandidates(kept, at);
  const run: DiscoveryRun = { at: at.toISOString(), added, updated, problems, units: (await quotaUsed(at)) - startUnits };
  await chrome.storage.local.set({ [DISCOVERY_KEY]: run });
  return run;
}
