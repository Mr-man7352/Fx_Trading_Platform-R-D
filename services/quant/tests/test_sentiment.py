"""QN-022 — FinBERT sentiment: signed scoring + point-in-time filter."""

from __future__ import annotations

from datetime import UTC, datetime

from app.market.sentiment import (
    Headline,
    SentimentScore,
    point_in_time,
    score_headlines,
)


class FakeModel:
    """Deterministic stand-in for FinBERT — no transformers/torch needed."""

    def __init__(self, mapping: dict[str, tuple[str, dict[str, float]]]) -> None:
        self._mapping = mapping

    def score(self, texts: list[str]) -> list[SentimentScore]:
        out: list[SentimentScore] = []
        for text in texts:
            label, probs = self._mapping[text]
            if label == "positive":
                signed = probs.get("positive", 0.0)
            elif label == "negative":
                signed = -probs.get("negative", 0.0)
            else:
                signed = 0.0
            out.append(SentimentScore(label=label, score=signed, probabilities=probs))
        return out


def _h(id_: str, when: str, text: str) -> Headline:
    return Headline(
        id=id_, published_at=datetime.fromisoformat(when).replace(tzinfo=UTC), text=text
    )


def test_score_headlines_binds_sentiment_to_published_at() -> None:
    model = FakeModel(
        {
            "ECB hikes": ("positive", {"positive": 0.9, "negative": 0.05, "neutral": 0.05}),
            "Recession fears": ("negative", {"positive": 0.1, "negative": 0.8, "neutral": 0.1}),
            "Rates unchanged": ("neutral", {"positive": 0.2, "negative": 0.2, "neutral": 0.6}),
        }
    )
    headlines = [
        _h("a", "2026-03-10T09:00:00", "ECB hikes"),
        _h("b", "2026-03-10T10:00:00", "Recession fears"),
        _h("c", "2026-03-10T11:00:00", "Rates unchanged"),
    ]
    scored = score_headlines(model, headlines)
    assert [round(s.sentiment, 2) for s in scored] == [0.9, -0.8, 0.0]
    # Each score stays bound to its original publish time.
    assert scored[0].published_at == headlines[0].published_at


def test_point_in_time_excludes_future_headlines() -> None:
    model = FakeModel(
        {
            "before": ("positive", {"positive": 0.7, "negative": 0.2, "neutral": 0.1}),
            "after": ("negative", {"positive": 0.2, "negative": 0.7, "neutral": 0.1}),
        }
    )
    scored = score_headlines(
        model,
        [
            _h("a", "2026-03-10T09:00:00", "before"),
            _h("b", "2026-03-10T11:00:00", "after"),
        ],
    )
    as_of = datetime.fromisoformat("2026-03-10T10:00:00").replace(tzinfo=UTC)
    visible = point_in_time(scored, as_of)
    assert [v.text for v in visible] == ["before"]  # no look-ahead


def test_score_headlines_empty() -> None:
    assert score_headlines(FakeModel({}), []) == []
