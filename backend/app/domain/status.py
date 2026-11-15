"""Clip / candidate state machine. All status changes must go through `transition`."""

from __future__ import annotations

from app.domain.enums import ClipStatus as S
from app.errors import InvalidTransitionError

ALLOWED_TRANSITIONS: dict[S, frozenset[S]] = {
    S.DETECTED: frozenset({S.PENDING_REVIEW, S.REJECTED}),
    S.PENDING_REVIEW: frozenset({S.APPROVED, S.REJECTED}),
    S.APPROVED: frozenset({S.CREATION_REQUESTED, S.UNSUPPORTED, S.REJECTED}),
    # A rejected candidate can be reconsidered by the editor.
    S.REJECTED: frozenset({S.PENDING_REVIEW}),
    S.CREATION_REQUESTED: frozenset({S.CREATED, S.FAILED, S.UNSUPPORTED}),
    S.CREATED: frozenset({S.EXPORTING, S.PUBLISHED}),
    S.EXPORTING: frozenset({S.READY, S.FAILED}),
    S.READY: frozenset({S.PUBLISHED, S.EXPORTING}),
    S.FAILED: frozenset({S.CREATION_REQUESTED, S.EXPORTING, S.REJECTED}),
    # Manual workflow: the editor clipped it by hand and marks it published.
    S.UNSUPPORTED: frozenset({S.PUBLISHED, S.REJECTED}),
    S.PUBLISHED: frozenset(),
}

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
