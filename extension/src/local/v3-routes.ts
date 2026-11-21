/** LocalApi routes for 3.0 data (discovery candidates, sources, rights). */
import { listCandidates, type Candidate } from "@/discovery/discovery";
import { listCreatorRights, setCreatorRights, type CreatorRights } from "./rights";
import { deleteSource, listSources, updateCandidate } from "./sources";

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: unknown) => Promise<unknown>;

/** Filters: via, platform, rights, include_dismissed. */
export function filterCandidates(all: Candidate[], q: URLSearchParams): Candidate[] {
  return all.filter(
    (c) =>
      (q.get("include_dismissed") === "1" || !c.dismissed) &&
      (!q.get("via") || c.via.includes(q.get("via") as Candidate["via"][number])) &&
      (!q.get("platform") || c.platform === q.get("platform")) &&
      (!q.get("rights") || c.rights.status === q.get("rights")),
  );
}

export function v3Routes(page: <T>(items: T[], q: URLSearchParams) => unknown): [string, RegExp, Handler][] {
  return [
    ["GET", /^\/api\/v1\/candidates$/, async (_m, q) => page(filterCandidates(await listCandidates(), q), q)],
    ["PATCH", /^\/api\/v1\/candidates\/(\d+)$/, (m, _q, b) => updateCandidate(Number(m[1]), (b ?? {}) as Parameters<typeof updateCandidate>[1])],
    ["GET", /^\/api\/v1\/sources$/, async (_m, q) => page(await listSources(), q)],
    ["DELETE", /^\/api\/v1\/sources\/(\d+)$/, async (m) => void (await deleteSource(Number(m[1])))],
    ["GET", /^\/api\/v1\/rights$/, async () => listCreatorRights()],
    ["POST", /^\/api\/v1\/rights$/, (_m, _q, b) => {
      const body = (b ?? {}) as { key?: string; platform?: CreatorRights["platform"]; creator_name?: string } & Parameters<typeof setCreatorRights>[2];
      if (!body.key || !/^[a-z]+:[^\s]{1,80}$/.test(body.key)) throw new Error("Invalid creator");
      return setCreatorRights(body.key, { platform: body.platform ?? "local", creator_name: String(body.creator_name ?? body.key).slice(0, 100) }, body);
    }],
  ];
}
