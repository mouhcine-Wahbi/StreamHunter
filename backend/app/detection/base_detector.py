from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable

from app.detection.models import THRESHOLDS, DetectorEvent, Strictness, Thresholds
from app.detection.window import Baseline, WindowFeatures
from app.domain.enums import Platform


def strictest(passes: Callable[[Thresholds], bool]) -> Strictness | None:
    """The strictest sensitivity level whose thresholds the observation satisfies."""
    for level in (Strictness.LOW, Strictness.MEDIUM, Strictness.HIGH):
        if passes(THRESHOLDS[level]):
            return level
    return None


class Detector(ABC):
    name: str

    @abstractmethod
    def evaluate(
        self, f: WindowFeatures, base: Baseline, *, platform: Platform, broadcaster_id: str
    ) -> list[DetectorEvent]: ...
