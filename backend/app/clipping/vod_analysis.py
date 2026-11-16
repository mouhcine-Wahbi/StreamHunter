"""Post-stream analysis of an authorized recording attached to a monitoring session.

1. Measures loudness per second and scene changes (FFmpeg).
2. Enriches the session's existing candidates with *measured* audio/visual signals and
   recomputes their score with the renormalized model (chat + audio + visual).
   When the sound classifier is installed, it also says what the audio *sounds like*
   (laughter, cheering, screaming): the stronger of loudness and sound becomes the audio signal,
   and a clear laughter/cheer/scream names the moment's category when chat didn't.
3. Adds audio-only candidates for laughter/cheering/screaming events and for strong loudness
   peaks that chat did not flag (loudness alone stays category "unknown").
4. Merges overlapping pending candidates.
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clipping import ffmpeg_processor as ff
from app.clipping.ffmpeg_processor import MediaProcessingError
from app.clipping.sound_classifier import SoundClassifier
from app.detection.audio_detector import delta_series, detect_audio_peaks, window_audio_score, window_visual_score
from app.detection.sound_events import (
    KIND_CATEGORY,
    Frame,
    SoundEvent,
    detect_sound_events,
    reason_for,
    sound_score,
    strongest,
    window_sounds,
)
from app.detection.scoring_engine import DEFAULT_WEIGHTS, calculate_score
from app.domain.enums import ClipStatus as S
from app.errors import AppError
from app.models import Clip, HighlightCandidate, MediaSource, MonitoringSession, StreamEvent
from app.schemas.settings import UserSettingsModel

AUDIO_ONLY_MIN_SCORE = 60.0
MAX_WINDOW = 180.0
LEAD = 5.0  # people often laugh a moment before chat reacts
NAMELESS = {"unknown", "other", "audience_reaction"}  # categories a clear sound may replace


def _merge_window(a: HighlightCandidate, b: HighlightCandidate) -> tuple[float, float]:
    start = min(a.start_offset_sec, b.start_offset_sec)  # type: ignore[type-var]
    end = max(a.end_offset_sec, b.end_offset_sec)  # type: ignore[type-var]
    return start, min(end, start + MAX_WINDOW)


async def analyze_recording(
    db: AsyncSession, media: MediaSource, path: Path, *, ffmpeg: str, timeout: float, settings: UserSettingsModel,
    classifier: SoundClassifier | None = None,
) -> dict[str, Any]:
    if media.session_id is None:
        raise AppError("Attach the recording to a monitoring session first", code="media_not_attached")
    session = await db.get(MonitoringSession, media.session_id)
    if session is None or session.user_id != media.user_id:
        raise AppError("Session not found", code="not_found")

    series = await ff.loudness_series(ffmpeg, path, timeout=timeout) if media.has_audio else []
    cuts = await ff.scene_changes(ffmpeg, path, timeout=timeout) if media.has_video else []
    deltas = delta_series(series) if series else []
    peaks = detect_audio_peaks(series)
    frames: list[Frame] = []
    sound_status = "not_installed"
    if not media.has_audio:
        sound_status = "no_audio"
    elif classifier is not None and classifier.available:
        try:
            frames = await classifier.classify(ffmpeg, path, timeout=timeout)
            sound_status = "done"
        except MediaProcessingError as exc:  # the rest of the analysis is still worth keeping
            sound_status = f"failed: {exc.message}"
    events = detect_sound_events(frames)
    duration = media.duration_sec or (series[-1][0] + 1 if series else 0.0)
    shift = media.offset_in_stream_sec  # stream offset = file time + shift

    def to_file(stream_t: float) -> float:
        return stream_t - shift

    def audio(start: float, end: float) -> float | None:
        return window_audio_score(deltas, to_file(start), to_file(end)) if deltas else None

    def sounds(start: float, end: float) -> dict[str, float] | None:
        return window_sounds(frames, to_file(start), to_file(end)) if frames else None

    def visual(start: float, end: float) -> float | None:
        return window_visual_score(cuts, to_file(start), to_file(end), duration) if media.has_video else None

    cands = list((await db.scalars(
        select(HighlightCandidate).where(HighlightCandidate.session_id == session.id).order_by(HighlightCandidate.start_offset_sec)
    )).unique())

    # 2. Enrich existing candidates the recording covers.
    enriched = 0
    for c in cands:
        if c.start_offset_sec is None or c.end_offset_sec is None or c.status == S.REJECTED.value:
            continue
        loud = audio(c.start_offset_sec, c.end_offset_sec)
        heard = sounds(c.start_offset_sec - LEAD, c.end_offset_sec)
        v = visual(c.start_offset_sec, c.end_offset_sec)
        if loud is None and heard is None and v is None:
            continue
        top = strongest(heard)
        a = _audio_signal(loud, heard)
        b = dict(c.signal_breakdown or {})
        chat = b.get("chat")
        b.setdefault("chat_only_score", c.score)
        b.update({"audio": a, "audio_loudness": loud, "sounds": heard, "visual": v,
                  "active_signals": [k for k, x in (("chat", chat), ("audio", a), ("visual", v)) if x is not None]})
        c.signal_breakdown = b
        c.score = round(calculate_score({"chat": chat, "audio": a, "visual": v, "context": None}, DEFAULT_WEIGHTS), 1)
        reasons = [r for r in c.reasons if not r.startswith("Audio ") and " in the audio (" not in r]
        if loud is not None and loud >= 40:
            reasons.append(f"Audio {round(loud * 0.15, 1)} dB louder than this recording's usual level")
        if top is not None:
            reasons.append(reason_for(*top))
            if c.category in NAMELESS:
                c.category = KIND_CATEGORY[top[0]]
        c.reasons = reasons
        enriched += 1

    # 3. Sound events and loudness peaks that no existing candidate covers.
    created = 0
    base_time = session.broadcast_started_at or session.started_at
    found: list[tuple[float, float, float, SoundEvent | None, float | None]] = (
        [(e.start, e.end, e.peak_t, e, None) for e in events] + [(p.start, p.end, p.peak_t, None, p.delta_db) for p in peaks]
    )
    for f0, f1, peak_t, event, delta_db in found:
        s0, s1 = f0 + shift, f1 + shift
        if any(c.start_offset_sec is not None and c.start_offset_sec - 10 <= s1 and s0 <= (c.end_offset_sec or 0) + 10 for c in cands):
            continue
        loud, heard, v = audio(s0, s1), sounds(s0, s1), visual(s0, s1)
        a = _audio_signal(loud, heard)
        score = round(calculate_score({"chat": None, "audio": a, "visual": v, "context": None}, DEFAULT_WEIGHTS), 1)
        if a is None or score < AUDIO_ONLY_MIN_SCORE:
            continue
        top = strongest(heard)
        start = max(0.0, s0 - settings.clips.preRollSeconds)
        end = min(start + MAX_WINDOW, s1 + settings.clips.postRollSeconds)
        reasons = []
        if top is not None:
            reasons.append(reason_for(*top) + (f" for {int(f1 - f0)} s" if event is not None and event.kind == top[0] else ""))
        if delta_db is not None:
            reasons.append(f"Audio {delta_db} dB louder than usual for {int(f1 - f0)} s")
        elif loud is not None and loud >= 40:
            reasons.append(f"Audio {round(loud * 0.15, 1)} dB louder than this recording's usual level")
        if v is not None and v >= 50:
            reasons.append("Many scene changes at the same time")
        c = HighlightCandidate(
            user_id=media.user_id, session_id=session.id, streamer_id=session.streamer_id, platform=session.platform,
            timestamp=base_time + timedelta(seconds=peak_t + shift), start_offset_sec=round(start, 1),
            end_offset_sec=round(end, 1), score=score, confidence=round(0.5 + (top[1] / 2 if top else 0.0), 3),
            category=KIND_CATEGORY[top[0]] if top else "unknown", reasons=reasons,
            signal_breakdown={"chat": None, "audio": a, "audio_loudness": loud, "sounds": heard, "visual": v, "context": None,
                              "weights": dict(DEFAULT_WEIGHTS),
                              "active_signals": ["audio"] + (["visual"] if v is not None else []),
                              "offsets_approximate": media.offset_in_stream_sec != 0 or session.broadcast_started_at is None},
            status=S.PENDING_REVIEW.value, origin="vod",
        )
        db.add(c)
        cands.append(c)
        created += 1
    for e in events:
        db.add(StreamEvent(session_id=session.id, streamer_id=session.streamer_id, event_type=e.kind,
                           stream_offset_sec=round(e.peak_t + shift, 1), confidence=min(0.95, e.peak),
                           event_metadata={"start": e.start + shift, "end": e.end + shift, "peak": e.peak, "score": e.score}))
    for p in peaks:
        db.add(StreamEvent(session_id=session.id, streamer_id=session.streamer_id, event_type="audio_peak",
                           stream_offset_sec=round(p.peak_t + shift, 1), confidence=min(0.95, p.score / 100),
                           event_metadata={"delta_db": p.delta_db, "start": p.start + shift, "end": p.end + shift, "score": p.score}))
    await db.flush()

    # 4. Merge overlapping *pending* candidates (never ones with a clip or a decision).
    merged = 0
    with_clips = set((await db.scalars(select(Clip.candidate_id).where(Clip.candidate_id.in_([c.id for c in cands])))).all())
    pending = sorted((c for c in cands if c.status == S.PENDING_REVIEW.value and c.start_offset_sec is not None
                      and c.end_offset_sec is not None), key=lambda c: c.start_offset_sec)  # type: ignore[arg-type,return-value]
    keep: HighlightCandidate | None = None
    for c in pending:
        if keep is not None and c.start_offset_sec <= keep.end_offset_sec and c.id not in with_clips:  # type: ignore[operator]
            keep.start_offset_sec, keep.end_offset_sec = _merge_window(keep, c)
            keep.score = max(keep.score, c.score)
            keep.confidence = max(keep.confidence, c.confidence)
            keep.reasons = list(dict.fromkeys(keep.reasons + c.reasons))
            if keep.category in ("unknown", "other"):
                keep.category = c.category
            keep.origin = "merged"
            await db.delete(c)
            merged += 1
        else:
            keep = c
    await db.flush()
    return {
        "duration_sec": duration,
        "audio_seconds": len(series),
        "audio_peaks": len(peaks),
        "sound_classification": sound_status,
        "sound_events": {k: sum(1 for e in events if e.kind == k) for k in KIND_CATEGORY},
        "scene_changes": len(cuts),
        "candidates_enriched": enriched,
        "candidates_created": created,
        "candidates_merged": merged,
    }



def _audio_signal(loud: float | None, heard: dict[str, float] | None) -> float | None:
    """The stronger of "how loud" and "how clearly laughter/cheering/screaming" (0–100)."""
    parts = [x for x in (loud, sound_score(max(heard.values())) if heard else None) if x is not None]
    return max(parts) if parts else None
