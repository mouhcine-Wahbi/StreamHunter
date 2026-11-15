"""Editor review and clip workflow (user-scoped).

Highlights:  pending_review → approved | rejected;  rejected → pending_review (reopen).
Clips (one active clip per highlight):
  Twitch  approved → creation_requested → created | failed (retry → creation_requested)
  Kick    unsupported (manual) → created (editor pastes the Kick clip URL)
  any created / unsupported clip → published, only with explicit confirmation.
"""

from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.domain.enums import ClipStatus as S, ConnectionStatus, Platform
from app.domain.status import transition
from app.errors import AppError, ConflictError, NotFoundError, PlatformUnavailableError
from app.models import Clip, HighlightCandidate, PlatformConnection, Streamer, User
from app.schemas.settings import UserSettingsModel

# Twitch keeps a short rolling buffer; a clip requested much later shows a different moment.
MAX_MOMENT_AGE = timedelta(seconds=90)
CLIP_HOSTS = {Platform.TWITCH: {"clips.twitch.tv", "www.twitch.tv", "twitch.tv"}, Platform.KICK: {"kick.com", "www.kick.com"}}


def manual_instructions(streamer: Streamer) -> str:
    return (
        f"Kick has no clip API. Open https://kick.com/{streamer.username}, create the clip there, "
        "then paste its URL here."
    )


def validate_clip_url(url: str, platform: Platform) -> str:
    u = urlparse(url.strip())
    if u.scheme != "https" or (u.hostname or "").lower() not in CLIP_HOSTS[platform] or len(url) > 500:
        raise AppError(
            f"Enter an https:// clip link on {', '.join(sorted(CLIP_HOSTS[platform]))}",
            code="validation_error",
        )
    return url.strip()


class ClipService:
    def __init__(self, db: AsyncSession, user: User):
        self.db = db
        self.user = user

    # --- lookups ------------------------------------------------------------------------------
    async def candidate(self, candidate_id: int) -> HighlightCandidate:
        c = await self.db.scalar(
            select(HighlightCandidate).where(HighlightCandidate.id == candidate_id, HighlightCandidate.user_id == self.user.id)
        )
        if c is None:
            raise NotFoundError("Highlight not found")
        return c

    async def clip(self, clip_id: int) -> Clip:
        c = await self.db.scalar(select(Clip).where(Clip.id == clip_id, Clip.user_id == self.user.id))
        if c is None:
            raise NotFoundError("Clip not found")
        return c

    async def clip_for(self, candidate_id: int) -> Clip | None:
        return await self.db.scalar(
            select(Clip).where(Clip.candidate_id == candidate_id, Clip.user_id == self.user.id).order_by(Clip.id.desc())
        )

    async def _settings(self) -> UserSettingsModel:
        from app.services.settings_service import SettingsService

        return await SettingsService(self.db, self.user).get()

    # --- review -------------------------------------------------------------------------------
    async def approve(self, candidate_id: int) -> tuple[HighlightCandidate, Clip]:
        cand = await self.candidate(candidate_id)
        cand.status = transition(cand.status, S.APPROVED).value
        clip = await self.clip_for(cand.id)
        if clip is None:
            streamer = cand.streamer
            settings = await self._settings()
            platform = Platform(cand.platform)
            clip = Clip(
                candidate_id=cand.id,
                user_id=self.user.id,
                platform=platform.value,
                aspect_ratio=settings.clips.defaultAspectRatio,
                duration_seconds=_window_seconds(cand),
                source="editor",
                status=S.APPROVED.value if platform == Platform.TWITCH else S.UNSUPPORTED.value,
                error_message=None if platform == Platform.TWITCH else manual_instructions(streamer),
            )
            self.db.add(clip)
        await self.db.flush()
        return cand, clip

    async def reject(self, candidate_id: int) -> HighlightCandidate:
        cand = await self.candidate(candidate_id)
        cand.status = transition(cand.status, S.REJECTED).value
        await self.db.flush()
        return cand

    async def update_candidate(self, candidate_id: int, *, reopen: bool, start: float | None, end: float | None,
                               category: str | None, fields: set[str]) -> HighlightCandidate:
        cand = await self.candidate(candidate_id)
        if reopen:
            cand.status = transition(cand.status, S.PENDING_REVIEW).value
        new_start = start if "start_offset_sec" in fields else cand.start_offset_sec
        new_end = end if "end_offset_sec" in fields else cand.end_offset_sec
        if new_start is not None and new_end is not None:
            if new_end <= new_start:
                raise AppError("end_offset_sec must be after start_offset_sec", code="validation_error")
            if new_end - new_start > 180:
                raise AppError("A highlight window can be at most 180 seconds", code="validation_error")
        cand.start_offset_sec, cand.end_offset_sec = new_start, new_end
        if category is not None:
            cand.category = category
        await self.db.flush()
        return cand

    # --- platform clip ------------------------------------------------------------------------
    async def prepare_request(self, clip_id: int, *, accept_current_moment: bool) -> Clip:
        """Validates and moves the clip to creation_requested. The caller commits and then
        hands the clip to ClipWorker.request (network call + confirmation)."""
        clip = await self.clip(clip_id)
        if clip.platform != Platform.TWITCH.value:
            raise ConflictError("This platform has no clip API; create the clip manually on the platform.",
                                code="requires_manual_action")
        if clip.status not in (S.APPROVED.value, S.FAILED.value):
            raise ConflictError(f"Clip is already '{clip.status}'", code="invalid_status_transition")
        cand = await self.db.get(HighlightCandidate, clip.candidate_id)
        assert cand is not None
        streamer = cand.streamer
        conn = await self.db.scalar(
            select(PlatformConnection).where(PlatformConnection.user_id == self.user.id, PlatformConnection.platform == "twitch")
        )
        if conn is None or conn.connection_status != ConnectionStatus.CONNECTED.value or "clips:edit" not in (conn.scopes or []):
            raise PlatformUnavailableError("Connect your Twitch account (with clip permission) to create clips.",
                                           code="requires_authorization")
        if streamer.is_live is not True:
            raise ConflictError("Twitch can only clip a live broadcast, and this channel is offline.", code="stream_offline")
        age = utcnow() - cand.timestamp
        if age > MAX_MOMENT_AGE and not accept_current_moment:
            raise ConflictError(
                f"This moment was {int(age.total_seconds() // 60)} min {int(age.total_seconds() % 60)} s ago. "
                "Twitch clips what is on stream right now, so the clip would not show it. "
                "Confirm to capture the current broadcast instead.",
                code="moment_passed",
                details={"moment_age_seconds": int(age.total_seconds())},
            )
        clip.status = transition(clip.status, S.CREATION_REQUESTED).value
        clip.error_message = None
        clip.platform_clip_id = None
        clip.edit_url = None
        await self.db.flush()
        return clip

    async def update_clip(self, clip_id: int, *, fields: set[str], title: str | None, aspect_ratio: str | None,
                          platform_clip_url: str | None) -> Clip:
        clip = await self.clip(clip_id)
        if "title" in fields:
            clip.title = (title or "").strip() or None
        if "aspect_ratio" in fields and aspect_ratio:
            clip.aspect_ratio = aspect_ratio
        if "platform_clip_url" in fields and platform_clip_url:
            platform = Platform(clip.platform)
            clip.platform_clip_url = validate_clip_url(platform_clip_url, platform)
            if clip.status in (S.UNSUPPORTED.value,):
                clip.status = transition(clip.status, S.CREATED).value
                clip.source = "manual"
                clip.error_message = None
            elif clip.status != S.CREATED.value:
                raise ConflictError("A clip URL can only be added to a manual or created clip", code="invalid_status_transition")
        await self.db.flush()
        return clip

    async def publish(self, clip_id: int, *, published_url: str | None) -> Clip:
        clip = await self.clip(clip_id)
        clip.status = transition(clip.status, S.PUBLISHED, user_confirmed=True).value
        clip.published_at = utcnow()
        clip.published_url = published_url
        await self.db.flush()
        return clip

    async def export(self, clip_id: int) -> None:
        clip = await self.clip(clip_id)
        raise ConflictError(
            "Export needs the video itself, and StreamHunter has no authorized media source for this clip. "
            + ("A Twitch clip is a page on Twitch, not a downloadable file; open it on Twitch instead."
               if clip.platform == "twitch" else "Download it from the platform if its terms allow."),
            code="media_unavailable",
        )


def _window_seconds(c: HighlightCandidate) -> int | None:
    if c.start_offset_sec is None or c.end_offset_sec is None:
        return None
    return int(round(c.end_offset_sec - c.start_offset_sec))


async def auto_capture_candidates(db: AsyncSession, candidates: list[HighlightCandidate]) -> list[int]:
    """Creates creation_requested clips for fresh Twitch candidates whose owners opted in,
    have a connected account with clips:edit, and whose score meets their minimum. Returns
    clip ids to hand to ClipWorker.request after commit."""
    out: list[int] = []
    for cand in candidates:
        if cand.platform != Platform.TWITCH.value:
            continue
        user = await db.get(User, cand.user_id)
        if user is None:
            continue
        from app.services.settings_service import SettingsService

        s = await SettingsService(db, user).get()
        if not s.clips.autoCreatePlatformClips or cand.score < s.detection.minHighlightScore:
            continue
        conn = await db.scalar(
            select(PlatformConnection).where(PlatformConnection.user_id == user.id, PlatformConnection.platform == "twitch")
        )
        if conn is None or conn.connection_status != ConnectionStatus.CONNECTED.value or "clips:edit" not in (conn.scopes or []):
            continue
        clip = Clip(candidate_id=cand.id, user_id=user.id, platform="twitch", aspect_ratio=s.clips.defaultAspectRatio,
                    duration_seconds=_window_seconds(cand), source="auto", status=S.CREATION_REQUESTED.value)
        db.add(clip)
        await db.flush()
        out.append(clip.id)
    return out
