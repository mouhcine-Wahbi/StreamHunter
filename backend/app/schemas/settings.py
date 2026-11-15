"""Per-user settings stored on the backend. Mirrors the extension's Settings type
(minus `backendUrl`, which is purely a client concern)."""

from __future__ import annotations

from typing import Literal
from zoneinfo import available_timezones

from pydantic import BaseModel, ConfigDict, Field, field_validator

KEYWORD_LANGUAGES = {"en", "es", "pt", "fr", "de", "it", "ar", "tr"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MonitoringSettings(_Strict):
    intervalMinutes: int = Field(2, ge=1, le=60)
    resumeOnStartup: bool = True


class DetectionSettings(_Strict):
    sensitivity: Literal["low", "medium", "high"] = "medium"
    minHighlightScore: int = Field(60, ge=0, le=100)
    keywordLanguages: list[str] = Field(default_factory=lambda: ["en"], max_length=len(KEYWORD_LANGUAGES))
    customKeywords: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("keywordLanguages")
    @classmethod
    def _langs(cls, v: list[str]) -> list[str]:
        unknown = set(v) - KEYWORD_LANGUAGES
        if unknown:
            raise ValueError(f"Unsupported languages: {sorted(unknown)}")
        return list(dict.fromkeys(v))

    @field_validator("customKeywords")
    @classmethod
    def _keywords(cls, v: list[str]) -> list[str]:
        out: dict[str, str] = {}
        for k in v:
            k = k.strip()
            if not k:
                continue
            if len(k) > 40:
                raise ValueError("Keywords must be at most 40 characters")
            out.setdefault(k.casefold(), k)
        return list(out.values())


class ClipSettings(_Strict):
    preRollSeconds: int = Field(20, ge=0, le=120)
    postRollSeconds: int = Field(10, ge=0, le=120)
    defaultAspectRatio: Literal["16:9", "9:16", "1:1"] = "9:16"
    # Twitch clips capture the broadcast at request time, so capture right when a highlight is
    # detected (unpublished; the editor still reviews it). Ignored on platforms without a clip API.
    autoCreatePlatformClips: bool = True


class NotificationSettings(_Strict):
    onHighlight: bool = True
    onStreamerLive: bool = False


class LocaleSettings(_Strict):
    timeZone: str = "auto"
    language: str = Field("en", max_length=10)

    @field_validator("timeZone")
    @classmethod
    def _tz(cls, v: str) -> str:
        if v != "auto" and v not in available_timezones():
            raise ValueError("Unknown IANA time zone")
        return v


class PrivacySettings(_Strict):
    retentionDays: int = Field(30, ge=1, le=365)


class UserSettingsModel(_Strict):
    monitoring: MonitoringSettings = Field(default_factory=MonitoringSettings)
    detection: DetectionSettings = Field(default_factory=DetectionSettings)
    clips: ClipSettings = Field(default_factory=ClipSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)
    locale: LocaleSettings = Field(default_factory=LocaleSettings)
    privacy: PrivacySettings = Field(default_factory=PrivacySettings)
