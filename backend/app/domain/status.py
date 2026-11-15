"""Clip / candidate state machine. All status changes must go through `transition`."""

from __future__ import annotations

from app.domain.enums import ClipStatus as S
from app.errors import InvalidTransitionError

ALLOWED_TRANSITIONS: dict[S, frozenset[S]] = {
    S.DETECTED: frozenset({S.PENDING_REVIEW, S.REJECTED}),
    S.PENDING_REVIEW: frozenset({S.APPROVED, S.REJECTED}),
    S.APPROVED: frozenset({S.CREATION_REQUESTED, S.UNSUPPORTED, S.REJECTED, S.EXPORTING}),
    # A rejected candidate can be reconsidered by the editor.
    S.REJECTED: frozenset({S.PENDING_REVIEW}),
    S.CREATION_REQUESTED: frozenset({S.CREATED, S.FAILED, S.UNSUPPORTED}),
    S.CREATED: frozenset({S.EXPORTING, S.PUBLISHED}),
    # On a failed export the clip returns to the state it had before (it keeps its platform clip).
    S.EXPORTING: frozenset({S.READY, S.FAILED, S.APPROVED, S.CREATED, S.UNSUPPORTED}),
    S.READY: frozenset({S.PUBLISHED, S.EXPORTING}),
    S.FAILED: frozenset({S.CREATION_REQUESTED, S.EXPORTING, S.REJECTED}),
    # Manual workflow (no platform API): the editor clips it on the platform and either pastes
    # the clip URL (→ created) or marks it published directly.
    S.UNSUPPORTED: frozenset({S.CREATED, S.PUBLISHED, S.REJECTED, S.EXPORTING}),
    S.PUBLISHED: frozenset(),
}

# Where a new clip row may start (clips are created, not transitioned into existence):
#   approved           – editor approved; platform clip not requested yet
#   creation_requested – requested immediately (auto-capture at detection time)
#   unsupported        – platform has no clip API (Kick): manual action needed
CLIP_INITIAL: frozenset[S] = frozenset({S.APPROVED, S.CREATION_REQUESTED, S.UNSUPPORTED})

# Reaching `published` is only ever done by an explicit user confirmation endpoint.
REQUIRES_USER_CONFIRMATION: frozenset[S] = frozenset({S.PUBLISHED})


def can_transition(current: S, target: S) -> bool:
    return target in ALLOWED_TRANSITIONS[current]


def transition(current: S | str, target: S | str, *, user_confirmed: bool = False) -> S:
    cur, tgt = S(current), S(target)
    if not can_transition(cur, tgt):
        raise InvalidTransitionError(
            f"Cannot change status from '{cur}' to '{tgt}'",
            details={"from": cur.value, "to": tgt.value, "allowed": sorted(s.value for s in ALLOWED_TRANSITIONS[cur])},
        )
    if tgt in REQUIRES_USER_CONFIRMATION and not user_confirmed:
        raise InvalidTransitionError(
            f"Changing status to '{tgt}' requires explicit user confirmation",
            code="confirmation_required",
        )
    return tgt
