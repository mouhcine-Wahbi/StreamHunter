"""Local sound classification with Google's YAMNet (AudioSet, 521 classes, Apache-2.0).

Runs on the CPU through LiteRT (`ai-edge-litert`, an optional dependency). The model file
(~4 MB) is downloaded once, on first use, into the models folder and checked against a fixed
SHA-256. Audio is decoded by FFmpeg and streamed through the model one second at a time, so a
long recording never has to fit in memory. Nothing leaves the backend machine.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import subprocess
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Protocol

from app.clipping.ffmpeg_processor import MediaProcessingError
from app.detection.sound_events import SOUND_KINDS, Frame

MODEL_URL = ("https://storage.googleapis.com/download.tensorflow.org/models/tflite/task_library/"
             "audio_classification/android/lite-model_yamnet_classification_tflite_1.tflite")
MODEL_SHA256 = "10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de"
MODEL_FILE = "yamnet.tflite"
RATE = 16_000
WINDOW = 15_600  # samples per inference (0.975 s), fixed by the model


class SoundClassifier(Protocol):
    @property
    def available(self) -> bool: ...

    async def classify(self, ffmpeg: str, path: Path, *, timeout: float) -> list[Frame]: ...


class YamnetClassifier:
    def __init__(self, model_dir: str | Path, *, model_url: str = MODEL_URL, model_sha256: str = MODEL_SHA256):
        self.model_dir = Path(model_dir)
        self.model_url = model_url
        self.model_sha256 = model_sha256
        self._lock = threading.Lock()
        self._model: tuple[Any, dict[str, list[int]]] | None = None

    @property
    def available(self) -> bool:
        return importlib.util.find_spec("ai_edge_litert") is not None

    @property
    def model_path(self) -> Path:
        return self.model_dir / MODEL_FILE

    def _download(self) -> None:
        self.model_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.model_path.with_suffix(".part")
        try:
            with urllib.request.urlopen(self.model_url, timeout=60) as r, tmp.open("wb") as f:  # noqa: S310 - fixed https URL
                while chunk := r.read(1 << 16):
                    f.write(chunk)
            if hashlib.sha256(tmp.read_bytes()).hexdigest() != self.model_sha256:
                raise MediaProcessingError("The downloaded sound model did not match its expected checksum")
            tmp.replace(self.model_path)
        except MediaProcessingError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface a readable reason on the job
            raise MediaProcessingError(
                f"Could not download the sound model (check the internet connection): {type(exc).__name__}"
            ) from exc
        finally:
            tmp.unlink(missing_ok=True)

    def _load(self) -> tuple[Any, dict[str, list[int]]]:
        with self._lock:
            if self._model is None:
                if not self.model_path.exists():
                    self._download()
                from ai_edge_litert.interpreter import Interpreter

                try:
                    with zipfile.ZipFile(self.model_path) as z:  # the label list is packed into the model file
                        labels = z.read("yamnet_label_list.txt").decode().splitlines()
                    interpreter = Interpreter(model_path=str(self.model_path))
                    interpreter.allocate_tensors()
                except Exception as exc:  # noqa: BLE001
                    raise MediaProcessingError(f"Could not load the sound model: {type(exc).__name__}") from exc
                index = {name: i for i, name in enumerate(labels)}
                groups = {kind: [index[n] for n in names if n in index] for kind, names in SOUND_KINDS.items()}
                self._model = (interpreter, groups)
            return self._model

    def _run(self, ffmpeg: str, path: Path, timeout: float) -> list[Frame]:
        import numpy as np

        interpreter, groups = self._load()
        inp = interpreter.get_input_details()[0]["index"]
        out = interpreter.get_output_details()[0]["index"]
        cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "error", "-i", str(path),
               "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]
        deadline = time.monotonic() + timeout
        frames: list[Frame] = []
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)  # noqa: S603
        try:
            assert proc.stdout is not None
            second = 0
            while chunk := proc.stdout.read(RATE * 2):
                if time.monotonic() > deadline:
                    raise MediaProcessingError(f"Sound classification took longer than {int(timeout)} s and was stopped")
                samples = np.frombuffer(chunk[: len(chunk) - len(chunk) % 2], dtype=np.int16).astype(np.float32) / 32768.0
                if len(samples) < RATE // 2:
                    break  # a last fragment under half a second says too little
                window = np.zeros(WINDOW, dtype=np.float32)
                window[: min(WINDOW, len(samples))] = samples[:WINDOW]
                interpreter.set_tensor(inp, window)
                interpreter.invoke()
                scores = interpreter.get_tensor(out)[0]
                frames.append((float(second), {k: round(float(max(scores[i] for i in ids)), 3)
                                                for k, ids in groups.items() if ids}))
                second += 1
            proc.wait(timeout=10)
            if proc.returncode not in (0, None):
                err = proc.stderr.read().decode(errors="replace").strip().splitlines() if proc.stderr else []
                tail = (err[-1:] or ["unknown error"])[0].replace(str(path), path.name)  # never expose server paths
                raise MediaProcessingError(f"ffmpeg failed while reading the audio: {tail[:200]}")
        finally:
            if proc.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                proc.wait()
        return frames

    async def classify(self, ffmpeg: str, path: Path, *, timeout: float) -> list[Frame]:
        if not self.available:
            raise MediaProcessingError("Sound classification is not installed on the backend (ai-edge-litert)")
        return await asyncio.to_thread(self._run, ffmpeg, path, timeout)
