"""Chat intelligence on simulated chat: detectors, anti-spam, categories, scoring, aggregation."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta

import pytest

from app.detection import lexicon
from app.detection.analyzer import StreamAnalyzer
from app.detection.models import CandidateDraft, ChatMessage, Strictness
from app.detection.scoring_engine import DEFAULT_WEIGHTS, calculate_score
from app.domain.enums import Platform
from tests.chat_sim import ChatSim


def run(analyzer: StreamAnalyzer, msgs: Iterable[ChatMessage], until: datetime) -> list[CandidateDraft]:
    """Feeds messages in time order and evaluates every 5 s, like the chat manager does."""
    drafts: list[CandidateDraft] = []
    msgs = sorted(msgs, key=lambda m: m.received_at)
    t = msgs[0].received_at if msgs else until
    i = 0
    while t <= until:
        while i < len(msgs) and msgs[i].received_at < t:
            analyzer.add(msgs[i])
            i += 1
        if (d := analyzer.evaluate(t)) is not None:
            drafts.append(d)
        t += timedelta(seconds=5)
    if (d := analyzer.flush()) is not None:
        drafts.append(d)
    return drafts


def scenario(*parts: Iterable[ChatMessage]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for p in parts:
        out.extend(p)
    return out


@pytest.fixture
def sim() -> ChatSim:
    return ChatSim()


def analyzer(**kw) -> StreamAnalyzer:  # type: ignore[no-untyped-def]
    a = StreamAnalyzer(Platform.TWITCH, "b1", broadcaster_login="thestreamer")
    a.configure(languages=kw.get("languages", {"en", "es", "pt", "fr"}), custom_keywords=kw.get("custom", set()))
    return a


# --- the quiet case: no false positives ---------------------------------------------------
def test_normal_chat_produces_nothing(sim: ChatSim) -> None:
    msgs = list(sim.normal(600, per_5s=5))
    assert run(analyzer(), msgs, sim.now) == []


def test_single_spammer_is_not_an_audience_reaction(sim: ChatSim) -> None:
    msgs = scenario(sim.normal(120), sim.spam(20, "u3", "KEKW KEKW KEKW", per_second=8), sim.normal(60))
    assert run(analyzer(), msgs, sim.now) == []


def test_bots_commands_and_broadcaster_are_ignored(sim: ChatSim) -> None:
    def noise():  # type: ignore[no-untyped-def]
        for i in range(60):
            t = sim.now + timedelta(seconds=i / 3)
            yield sim.msg("nightbot", "Follow the socials! clip it", at=t)
            yield sim.msg(f"u{i}", "!uptime", at=t)
            yield sim.msg("thestreamer", "lol", at=t)
        sim.now += timedelta(seconds=20)

    msgs = scenario(sim.normal(120), noise(), sim.normal(60))
    assert run(analyzer(), msgs, sim.now) == []


# --- detection ----------------------------------------------------------------------------
def test_funny_emote_wave_is_detected_and_explained(sim: ChatSim) -> None:
    msgs = scenario(sim.normal(180), sim.burst(12, users=40, text="KEKW", emotes=("KEKW",)), sim.normal(60))
    [d] = run(analyzer(), msgs, sim.now)
    assert d.category == "funny_moment"
    assert d.score >= 60 and 0 < d.confidence < 1
    types = {e.event_type for e in d.events}
    assert {"chat_spike", "emote_wave"} <= types
    assert any("KEKW" in r and "chatters" in r for r in d.reasons)
    assert any("normal level" in r for r in d.reasons)
    assert d.strictness == Strictness.LOW  # strong enough for even the least sensitive users
    # The moment lies inside the burst.
    assert timedelta(0) <= d.end_at - d.start_at <= timedelta(seconds=40)


def test_clip_requests_are_detected(sim: ChatSim) -> None:
    msgs = scenario(sim.normal(180), sim.burst(10, users=8, text="CLIP IT"), sim.normal(60))
    [d] = run(analyzer(), msgs, sim.now)
    assert any(e.event_type == "clip_request" for e in d.events)
    assert any("asked to clip it" in r for r in d.reasons)


@pytest.mark.parametrize(
    ("text", "languages", "category"),
    [
        ("NO WAY", {"en"}, "unexpected_reaction"),
        ("jajajajaja", {"es"}, "funny_moment"),
        ("kkkkkkkk", {"pt"}, "funny_moment"),
        ("MDRRRR", {"fr"}, "funny_moment"),
        ("LETS GOOOO", {"en"}, "exciting_moment"),
    ],
)
def test_multilingual_reactions(sim: ChatSim, text: str, languages: set[str], category: str) -> None:
    # Vary the spelling per chatter so this is a reaction, not just one repeated phrase.
    def wave():  # type: ignore[no-untyped-def]
        crowd = sim.rng.sample(sim.users, 30)
        for i, u in enumerate(crowd):
            yield sim.msg(u, text + "!" * (i % 3) + (" " + text.split()[0] if i % 4 == 0 else ""),
                          at=sim.now + timedelta(seconds=i / 3))
        sim.now += timedelta(seconds=10)

    msgs = scenario(sim.normal(180), wave(), sim.normal(60))
    drafts = run(analyzer(languages=languages), msgs, sim.now)
    assert drafts, f"no candidate for {text!r}"
    assert drafts[0].category == category
    assert any(e.event_type == "reaction" for e in drafts[0].events)


def test_language_pack_must_be_enabled(sim: ChatSim) -> None:
    def wave():  # type: ignore[no-untyped-def]
        crowd = sim.rng.sample(sim.users, 30)
        for i, u in enumerate(crowd):
            yield sim.msg(u, "kkkk" + "k" * (i % 5) + " " + "rsrs" * (i % 2), at=sim.now + timedelta(seconds=i / 3))
        sim.now += timedelta(seconds=10)

    msgs = scenario(sim.normal(180), wave(), sim.normal(60))
    drafts = run(analyzer(languages={"en"}), msgs, sim.now)
    # Still a volume spike, but without the Portuguese pack it can't be called "funny".
    assert all(d.category != "funny_moment" for d in drafts)


def test_custom_keywords_count_as_reactions(sim: ChatSim) -> None:
    def wave():  # type: ignore[no-untyped-def]
        for i, u in enumerate(sim.rng.sample(sim.users, 25)):
            yield sim.msg(u, "absolute cinema" + "!" * (i % 3), at=sim.now + timedelta(seconds=i / 3))
        sim.now += timedelta(seconds=9)

    msgs = scenario(sim.normal(180), wave(), sim.normal(60))
    drafts = run(analyzer(custom={"absolute cinema"}), msgs, sim.now)
    assert drafts and any(e.event_type == "reaction" and e.metadata["reaction"] == "custom" for e in drafts[0].events)


def test_spike_is_relative_to_each_streams_baseline() -> None:
    """The same absolute volume is a spike in a quiet chat and normal in a busy one."""
    quiet, busy = ChatSim(seed=1), ChatSim(seed=2, chatters=400)
    burst_quiet = scenario(quiet.normal(180, per_5s=2), quiet.burst(15, users=30, text="ok"), quiet.normal(30, per_5s=2))
    busy_msgs = list(busy.normal(240, per_5s=30))
    assert run(analyzer(), burst_quiet, quiet.now), "30 chatters in 15 s is unusual for a quiet chat"
    assert run(analyzer(), busy_msgs, busy.now) == [], "…but normal for a busy one"


def test_sensitivity_levels(sim: ChatSim) -> None:
    msgs = scenario(sim.normal(180, per_5s=3), sim.burst(15, users=7, text="omg"), sim.normal(60, per_5s=3))
    drafts = run(analyzer(), msgs, sim.now)
    assert drafts, "high sensitivity should see a small reaction"
    assert all(d.strictness < Strictness.LOW for d in drafts), "low sensitivity should not"


def test_two_waves_close_together_merge_into_one_candidate(sim: ChatSim) -> None:
    msgs = scenario(
        sim.normal(180),
        sim.burst(8, users=30, text="KEKW", emotes=("KEKW",)),
        sim.normal(4),
        sim.burst(8, users=30, text="CLIP IT"),
        sim.normal(90),
    )
    drafts = run(analyzer(), msgs, sim.now)
    assert len(drafts) == 1
    assert {"emote_wave", "clip_request"} <= {e.event_type for e in drafts[0].events}


def test_separate_moments_stay_separate(sim: ChatSim) -> None:
    msgs = scenario(
        sim.normal(180),
        sim.burst(10, users=35, text="KEKW", emotes=("KEKW",)),
        sim.normal(150),
        sim.burst(10, users=35, text="NO WAY"),
        sim.normal(60),
    )
    drafts = run(analyzer(), msgs, sim.now)
    assert len(drafts) == 2
    assert drafts[0].category == "funny_moment" and drafts[1].category == "unexpected_reaction"


def test_activity_snapshot_has_no_message_content(sim: ChatSim) -> None:
    a = analyzer()
    for m in sim.normal(120, per_5s=6):
        a.add(m)
    snap = a.activity(sim.now)
    assert snap["messages_per_minute"] > 0 and snap["warming_up"] is False
    assert len(snap["series"]) == 36
    assert not any(isinstance(v, str) and "chat" in v for v in snap.values())


# --- units --------------------------------------------------------------------------------
def test_renormalized_score_ignores_missing_signals() -> None:
    assert calculate_score({"chat": 80, "audio": None, "visual": None, "context": None}, DEFAULT_WEIGHTS) == 80
    both = calculate_score({"chat": 80, "audio": 40, "visual": None, "context": None}, DEFAULT_WEIGHTS)
    assert both == pytest.approx((80 * 0.25 + 40 * 0.30) / 0.55)
    assert calculate_score({"chat": None}, DEFAULT_WEIGHTS) == 0


def test_lexicon_normalization_and_matching() -> None:
    idx = lexicon.build_reaction_index({"en", "es"}, {"Big Brain"})
    assert lexicon.normalize("LOOOOOL!!!") == "lol"
    assert lexicon.normalize("jajajajaja") == "jaja" and lexicon.normalize("MDRRRR") == "mdr"
    assert "shock" in lexicon.match_reactions(lexicon.normalize("NO WAAAY!!"), idx)
    assert lexicon.has_interrobang("WHAT?!")
    assert "funny" in lexicon.match_reactions(lexicon.normalize("jaja"), idx)
    assert lexicon.match_reactions("big brain", idx) == {"custom"}
    # single common words only count in short messages
    assert lexicon.match_reactions("what time does the stream end today", idx) == set()
    assert lexicon.is_clip_request("clip it") and lexicon.is_clip_request("clip that pls")
    assert not lexicon.is_clip_request("i was watching a clip yesterday from another stream")


def test_lexicon_has_no_ambiguous_phrases_after_normalization() -> None:
    seen: dict[str, str] = {}
    clashes = []
    for lang, cats in lexicon.REACTIONS.items():
        for cat, phrases in cats.items():
            for p in phrases:
                n = lexicon.normalize(p)
                if seen.setdefault(n, cat) != cat:
                    clashes.append((lang, p, n, seen[n], cat))
    assert clashes == []
