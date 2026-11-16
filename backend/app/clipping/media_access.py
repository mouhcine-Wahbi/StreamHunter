"""Per-user media library with strict path containment.

Only files inside <media_root>/library/<user_id>/ can be used: no absolute paths, no "..",
no symlinks pointing elsewhere. Exports go to <media_root>/exports/<user_id>/.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.errors import AppError, PlatformUnavailableError

ALLOWED_EXTENSIONS = frozenset({".mp4", ".mkv", ".mov", ".webm", ".flv", ".ts", ".m4a", ".mp3", ".wav", ".aac"})
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True, slots=True)
class Probe:
    duration_sec: float | None
    has_audio: bool
    has_video: bool
    width: int | None
    height: int | None


def find_tool(configured: str, name: str) -> str:
    """The configured FFmpeg tool, or the binary of the optional `static-ffmpeg` package.

    Only an explicit default ("ffmpeg"/"ffprobe") that isn't on PATH falls back, and only to
    binaries static-ffmpeg has already unpacked (nothing is downloaded here).
    """
    if shutil.which(configured) is not None or configured != name:
        return configured
    try:
        from static_ffmpeg.run import get_platform_dir
    except ImportError:
        return configured
    try:
        candidate = Path(get_platform_dir()) / name
    except OSError:
        return configured
    return str(candidate) if candidate.is_file() else configured


class MediaLibrary:
    def __init__(self, root: str | Path, *, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe"):
        self.root = Path(root).resolve()
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe

    @property
    def available(self) -> bool:
        return shutil.which(self.ffmpeg) is not None and shutil.which(self.ffprobe) is not None

    def require_tools(self) -> None:
        if not self.available:
            raise PlatformUnavailableError(
                "FFmpeg/ffprobe are not installed on the backend machine (needed for media analysis and export).",
                code="ffmpeg_unavailable",
            )

    def library_dir(self, user_id: int) -> Path:
        d = self.root / "library" / str(user_id)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def export_dir(self, user_id: int) -> Path:
        d = self.root / "exports" / str(user_id)
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def safe_filename(name: str) -> str:
        stem = Path(name).name  # drop any directories the client sent
        ext = Path(stem).suffix.lower()
        base = _SAFE_NAME.sub("_", Path(stem).stem)[:80].strip("._") or "recording"
        return f"{base}{ext}"

    def resolve(self, user_id: int, relative: str) -> Path:
        """Absolute path of a file in the user's library, refusing anything outside it."""
        base = self.library_dir(user_id).resolve()
        rel = Path(relative)
        if rel.is_absolute() or ".." in rel.parts:
            raise AppError("Use a path relative to your StreamHunter media folder", code="invalid_media_path")
        p = (base / rel).resolve()
        if base not in p.parents:
            raise AppError("Path is outside your media folder", code="invalid_media_path")
        if p.suffix.lower() not in ALLOWED_EXTENSIONS:
            raise AppError(f"Unsupported file type; use one of {', '.join(sorted(ALLOWED_EXTENSIONS))}", code="invalid_media_type")
        if not p.is_file():
            raise AppError("File not found in your media folder", code="media_not_found")
        return p

    def resolve_export(self, user_id: int, name: str) -> Path:
        base = self.export_dir(user_id).resolve()
        p = (base / Path(name).name).resolve()
        if base not in p.parents:
            raise AppError("Invalid export path", code="invalid_media_path")
        return p

    async def probe(self, path: Path) -> Probe:
        from app.clipping.ffmpeg_processor import MediaProcessingError, run

        try:
            out = await run([self.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                            timeout=60)
        except MediaProcessingError as exc:
            raise AppError(f"'{path.name}' could not be read as audio or video", code="invalid_media") from exc
        try:
            data = json.loads(out.stdout or "{}")
        except ValueError as exc:
            raise AppError("Could not read the media file", code="invalid_media") from exc
        streams = data.get("streams") or []
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        if video is None and audio is None:
            raise AppError("The file contains no audio or video streams", code="invalid_media")
        try:
            duration = float((data.get("format") or {}).get("duration"))
        except (TypeError, ValueError):
            duration = None
        return Probe(
            duration_sec=duration,
            has_audio=audio is not None,
            has_video=video is not None,
            width=int(video["width"]) if video and video.get("width") else None,
            height=int(video["height"]) if video and video.get("height") else None,
        )
