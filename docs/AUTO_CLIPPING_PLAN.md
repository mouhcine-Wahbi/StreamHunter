# Automatic clipping: technical plan

Goal: the editor picks streamers, clicks **Start Monitoring**, leaves the computer, and comes back to a
ranked library of MP4 clips. No backend, no cloud.

## 1. What already works (v1.0, inspected before this change)

| Piece | State |
|---|---|
| Search, live status, live-now lists, monitoring list (Twitch, Kick) | Works (fake-API tests; real APIs need the editor's app credentials) |
| Background status checks, sessions per broadcast, stream end, notifications | Works |
| Twitch chat detection (EventSub, `StreamAnalyzer`) → provisional highlights | Works in tests |
| Viewer-spike detection | Works |
| Capture engine: tabCapture → WebCodecs H.264/AAC → 120 s ring → MP4 in IndexedDB | **Verified in real Chrome** |
| Capture signals: loudness, motion, flash; Save last N s | Verified in real Chrome |
| Top Highlights (highlights list), Clip Library (preview, rename, download, delete) | Works |

## 2. What is missing for "fully automatic"

1. **Capture needs a click on every stream.** Chrome only lets an extension capture a tab after the
   user invokes the extension on it, and there is no way around that.
   *Verified in real Chrome (Chrome 157):* once a capture runs, it **keeps running when the tab
   navigates**, both to the same site and to a different one. So one click is enough: the editor makes one tab the
   **recorder tab**, and StreamHunter then navigates that tab to whichever selected streamer is live,
   pauses encoding while nobody is live, and switches channels on its own.
2. **Single-signal clips.** The engine clips on one loud second. The new spec asks for fused signals
   with configurable weights (audio 25, chat 30, visual 20, viewers 15, multi-signal bonus 10).
3. **Chat and capture make separate highlights for the same moment** (duplicates).
4. No thumbnails, no clip metadata (category, reasons, detection types), no favourites.
5. No storage limit or automatic cleanup; the buffer length is fixed.
6. No pause/resume; the monitoring UI does not show the pipeline stages separately.
7. Audio detection is only loudness: no laughter/cheer/scream cues, no scene-cut detection.

## 3. Design

```text
Service worker (director)                         Offscreen document (engine)
─────────────────────────                         ───────────────────────────
alarm → status check → sessions                   tab stream → encoders → ChunkRing (buffer)
  → choose target: live streamer with              per second: AudioFeatures + VisualFeatures
    "Auto-record" on (current one kept               → LiveSignals → signal events (audio, visual)
    while live, else most viewers)                 FusionEngine (pure, tested):
  → recorder tab: navigate + retarget ───────────▶   events from audio/visual/chat/viewers
  → offline: engine idle (no encoding) ──────────▶   grouped into moments (10 s quiet gap, 60 s max)
chat-manager: chat moment ─┐                         score = Σ weight × intensity + multi bonus
viewer spike ──────────────┴─ signal ────────────▶   ≥ threshold → ClipPlanner (overlap/merge)
   (provisional highlight kept only if                → wait for post-roll → MP4 + thumbnail
    the moment was not fused into a clip)              → IndexedDB (clips, clipBlobs, clipThumbs)
storage limits after each clip ◀── clip-saved ──── 
```

* **FusionEngine** (`src/detection/fusion.ts`): pure. Signals `{kind, at, intensity 0–100, reasons}`
  are grouped; a group closes 10 s after its last signal (chat arrives late, so the close waits).
  Score = `Σ weight_k × max intensity_k / 100` + bonus when ≥ 2 kinds, capped at 100. With the
  default weights no single signal can reach the default threshold (40), so **one signal alone never
  makes a clip**.
* **ClipPlanner**: a new moment inside a clip that has not been cut yet extends it (max 90 s); a moment
  inside an already-cut clip only adds its reasons to it; a moment whose pre-roll overlaps the
  previous clip starts where that clip ended. No duplicate footage.
* **Buffer**: configurable (60–300 s, default 120), and always at least pre + post + 60 s, so a
  moment's footage is still there when its post-roll ends.
* **Audio features** per second: loudness, onset (sudden change), zero-crossing rate (noise-like /
  high-pitched sound), and envelope rhythm at 3–7 Hz (laughter-like bursts). They are heuristics and
  are labelled that way ("laughter-like bursts", "crowd/cheer-like noise", "shouting").
* **Visual features**: motion, scene cuts (large whole-frame change), flashes.
* **Honesty**: the pipeline panel shows five separate states: discovery, chat, video capture,
  detection, clip export. "Live, video capture inactive" is shown when a selected streamer is live
  and no recorder tab is armed.
* **Storage**: Settings → Storage: maximum total size (default 5 GB), maximum age (off by default),
  favourites never auto-deleted. Runs after each clip and each status check.
* **Twitch native clips** (optional, off by default): with Sign in with Twitch plus the `clips:edit`
  scope, StreamHunter also calls `POST /helix/clips` for each fused Twitch clip.
* **Kick**: no chat (webhooks only). Live status, viewers and capture work; this is shown in the UI.

## 4. Steps

1. Fusion + planner + audio/visual features (pure modules, unit tests).
2. Engine: fused detection, external signals, thumbnails, idle/retarget, configurable buffer.
3. Data: DB v2 (`clipThumbs`), clip metadata, favourites, storage limits + cleanup.
4. Director: recorder tab, auto-record streamers, pause/resume/stop, forwarding of chat/viewer signals.
5. Dashboard: Overview, Top Highlights (ranked clips + filters), Clip Library, pipeline panel.
6. Optional Twitch native clips.
7. Tests, real-Chrome run (recorder switching channels, fused clip), docs.
