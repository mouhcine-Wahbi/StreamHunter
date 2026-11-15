"""FFmpeg wrappers: loudness series, scene changes, and clip export.

All commands are built as argument lists (never through a shell), run with timeouts, and
only ever read files from the user's media library.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
from dataclasses import dataclass
from pathlib import Path

from app.errors import AppError

AspectRatio = str  # "16:9" | "9:16" | "1:1"

_PTS = re.compile(r"pts_time:([0-9.]+)")
_RMS = re.compile(r"lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-inf|inf|nan)")


@dataclass(slots=True)
class RunResult:
    returncode: int
    stdout: str
    stderr: str


class MediaProcessingError(AppError):
    status_code = 500
    code = "media_processing_failed"


async def run(cmd: list[str], *, timeout: float) -> RunResult:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise MediaProcessingError(f"{Path(cmd[0]).name} took longer than {int(timeout)} s and was stopped")
    result = RunResult(proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace"))
    if result.returncode != 0:
        tail = (result.stderr.strip().splitlines()[-1:] or ["unknown error"])[0]
        # Never expose server paths in error messages: show file names only.
        for arg in cmd[1:]:
            if "/" in arg and Path(arg).name:
                tail = tail.replace(arg, Path(arg).name)
        raise MediaProcessingError(f"{Path(cmd[0]).name} failed: {tail[:200]}")
    return result


async def loudness_series(ffmpeg: str, path: Path, *, timeout: float) -> list[tuple[float, float]]:
    """(second, RMS dBFS) for each second of audio. Silence is reported as -90 dB."""
    af = "aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"
    res = await run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", af, "-f", "null", "-"], timeout=timeout)
    series: list[tuple[float, float]] = []
    t: float | None = None
    for line in res.stdout.splitlines():
        if (m := _PTS.search(line)) is not None:
            t = float(m.group(1))
        elif (m := _RMS.search(line)) is not None and t is not None:
            v = m.group(1)
            db = -90.0 if v in {"-inf", "nan", "inf"} else max(-90.0, float(v))
            series.append((round(t, 2), db))
    return series


async def scene_changes(ffmpeg: str, path: Path, *, threshold: float = 0.35, timeout: float) -> list[float]:
    """Timestamps of hard cuts / big visual changes (downscaled and decimated, so it's cheap)."""
    vf = f"fps=2,scale=160:-2,select='gt(scene,{threshold})',showinfo"
    res = await run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf", vf, "-f", "null", "-"], timeout=timeout)
    return [float(m.group(1)) for line in res.stderr.splitlines() if "Parsed_showinfo" in line and (m := _PTS.search(line))]


def aspect_filter(aspect: AspectRatio) -> str:
    if aspect == "9:16":  # centre crop to vertical, then 1080×1920
        return "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1"
    if aspect == "1:1":
        return "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2,setsar=1"
    return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1"


async def export_clip(
    ffmpeg: str, src: Path, dst: Path, *, start: float, duration: float, aspect: AspectRatio,
    has_video: bool, has_audio: bool, timeout: float,
) -> None:
    """Trim, reframe and loudness-normalize into an MP4 (H.264/AAC, web-optimized)."""
    cmd = [ffmpeg, "-hide_banner", "-nostats", "-y", "-ss", f"{max(0.0, start):.3f}", "-i", str(src), "-t", f"{duration:.3f}"]
    if has_video:
        cmd += ["-vf", aspect_filter(aspect), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
    else:
        cmd += ["-vn"]
    if has_audio:
        cmd += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
    else:
        cmd += ["-an"]
    tmp = dst.with_suffix(".partial.mp4")
    cmd += ["-movflags", "+faststart", str(tmp)]
    try:
        await run(cmd, timeout=timeout)
        tmp.replace(dst)  # atomic: never leave a half-written file under the final name
    finally:
        tmp.unlink(missing_ok=True)
