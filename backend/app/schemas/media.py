from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.schemas.common import Schema


class MediaCapabilitiesOut(Schema):
    ffmpeg_available: bool
    max_upload_mb: int
    media_folder: str  # where to put files for "register" (on the backend machine)
    supported_extensions: list[str]
    audio_analysis: str
    visual_analysis: str
    export: str
    subtitles: str
    sound_events: str  # laughter / cheering / screaming in recordings
    live_tab_audio: str
    live_sound_events: str  # laughter / cheering / screaming in live tab audio (opt-in in the extension)
    platform_vod_download: str


class MediaRegister(Schema):
    model_config = {"extra": "forbid"}
    relative_path: str = Field(min_length=1, max_length=500)
    session_id: int | None = None
    offset_in_stream_sec: float = Field(0.0, ge=0)
    rights_confirmed: Literal[True]  # the editor confirms they may process this recording


class MediaPatch(Schema):
    model_config = {"extra": "forbid"}
    session_id: int | None = None
    offset_in_stream_sec: float | None = Field(None, ge=0)


class MediaSourceOut(Schema):
    id: int
    session_id: int | None
    kind: str
    original_name: str
    size_bytes: int
    duration_sec: float | None
    has_audio: bool
    has_video: bool
    width: int | None
    height: int | None
    offset_in_stream_sec: float
    rights_confirmed_at: datetime
    status: str
    error_message: str | None
    created_at: datetime


class MediaJobOut(Schema):
    id: int
    kind: str
    media_source_id: int
    clip_id: int | None
    status: str
    result: dict[str, Any]
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
