import type { MonitoringSession, Streamer } from "@/types/api";
import { db } from "./db";

/**
 * A session is one broadcast of a monitored streamer, as seen by StreamHunter: it opens when a
 * live-status check finds the streamer live and ends when a later check finds them offline.
 * Highlights and clips belong to a session.
 */
export async function listSessions(): Promise<MonitoringSession[]> {
  return (await db.all<MonitoringSession>("sessions")).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export async function getSession(id: number): Promise<MonitoringSession | undefined> {
  return db.get<MonitoringSession>("sessions", id);
}

export async function activeSessionFor(streamerId: number): Promise<MonitoringSession | undefined> {
  return (await db.byIndex<MonitoringSession>("sessions", "streamer", streamerId)).find((s) => s.status === "active");
}

export interface SessionSync {
  opened: MonitoringSession[];
  ended: MonitoringSession[];
  active: number;
}

/**
 * Makes sessions match the streamers' live state after a status check. Only streamers whose state
 * was actually checked (`checkedIds`) are touched, so a platform that couldn't be reached doesn't
 * end its sessions.
 */
export async function syncSessions(checkedIds: Set<number>, at: Date): Promise<SessionSync> {
  const streamers = await db.all<Streamer>("streamers");
  const sessions = await db.all<MonitoringSession>("sessions");
  const out: SessionSync = { opened: [], ended: [], active: 0 };
  const iso = at.toISOString();
  for (const s of streamers) {
    const active = sessions.find((x) => x.streamer_id === s.id && x.status === "active");
    if (!checkedIds.has(s.id)) {
      if (active) out.active += 1;
      continue;
    }
    if (s.is_live && s.monitoring_enabled && !active) {
      const created = await db.put<MonitoringSession>("sessions", {
        id: undefined as unknown as number,
        streamer_id: s.id,
        streamer_display_name: s.display_name,
        platform: s.platform,
        broadcast_started_at: s.stream_started_at,
        started_at: iso,
        ended_at: null,
        status: "active",
        last_checked_at: iso,
        last_event_at: null,
        error_message: null,
      });
      out.opened.push(created);
      out.active += 1;
    } else if (active && (!s.is_live || !s.monitoring_enabled)) {
      out.ended.push(await db.put("sessions", { ...active, status: "ended", ended_at: iso, last_checked_at: iso }));
    } else if (active) {
      await db.put("sessions", { ...active, last_checked_at: iso });
      out.active += 1;
    }
  }
  // A streamer removed from the list ends its session too.
  for (const x of sessions) {
    if (x.status === "active" && !streamers.some((s) => s.id === x.streamer_id)) {
      out.ended.push(await db.put("sessions", { ...x, status: "ended", ended_at: iso }));
    }
  }
  return out;
}

/** When monitoring stops, open sessions are paused (they resume on the next check if still live). */
export async function pauseActiveSessions(at: Date): Promise<void> {
  for (const s of await db.all<MonitoringSession>("sessions")) {
    if (s.status === "active") await db.put("sessions", { ...s, status: "paused", last_checked_at: at.toISOString() });
  }
}

/** A paused session continues if its streamer is still live in the same broadcast. */
export async function resumePausedSessions(): Promise<void> {
  const streamers = await db.all<Streamer>("streamers");
  for (const s of await db.all<MonitoringSession>("sessions")) {
    if (s.status !== "paused") continue;
    const st = streamers.find((x) => x.id === s.streamer_id);
    const same = st?.is_live && (s.broadcast_started_at === null || s.broadcast_started_at === st.stream_started_at);
    await db.put("sessions", same ? { ...s, status: "active" } : { ...s, status: "ended", ended_at: s.last_checked_at ?? s.started_at });
  }
}
