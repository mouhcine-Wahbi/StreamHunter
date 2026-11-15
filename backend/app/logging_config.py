"""Structured JSON logging with secret redaction."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime

_SECRET_PATTERNS = [
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)((?:access|refresh)_token|client_secret|password|code)=([^&\s]+)"),
    re.compile(r'(?i)("(?:access_token|refresh_token|client_secret|password)"\s*:\s*")[^"]*(")'),
]


def redact(text: str) -> str:
    text = _SECRET_PATTERNS[0].sub(r"\1[REDACTED]", text)
    text = _SECRET_PATTERNS[1].sub(r"\1=[REDACTED]", text)
    text = _SECRET_PATTERNS[2].sub(r"\1[REDACTED]\2", text)
    return text


class JsonFormatter(logging.Formatter):
    _RESERVED = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "color_message"}

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        for key, value in record.__dict__.items():
            if key not in self._RESERVED and not key.startswith("_"):
                payload[key] = redact(value) if isinstance(value, str) else value
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # Access logs would include query strings; keep them but redacted via the root handler.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
