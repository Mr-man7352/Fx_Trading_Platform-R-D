"""FinBERT point-in-time sentiment scoring (QN-022).

Scores news headlines with a local FinBERT model and keeps each score bound to
its `published_at`, so a backtest reading sentiment "as of" a bar can never see
a headline published after that bar (no look-ahead). The model is a Protocol:
the real `FinBertModel` lazily loads transformers (the `ml` dependency-group),
while tests inject a deterministic fake — so this module imports with no heavy
ML deps installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from datetime import datetime


@dataclass(frozen=True, slots=True)
class Headline:
    id: str
    published_at: datetime
    text: str


@dataclass(frozen=True, slots=True)
class SentimentScore:
    """`score` is signed in [-1, 1]: +conf positive, -conf negative, 0 neutral."""

    label: str
    score: float
    probabilities: dict[str, float]


@dataclass(frozen=True, slots=True)
class ScoredHeadline:
    id: str
    published_at: datetime
    text: str
    sentiment: float
    label: str


class SentimentModel(Protocol):
    def score(self, texts: list[str]) -> list[SentimentScore]: ...


def _signed(label: str, probabilities: dict[str, float]) -> float:
    """Collapse a label distribution to a signed scalar in [-1, 1]."""
    pos = probabilities.get("positive", 0.0)
    neg = probabilities.get("negative", 0.0)
    if label == "positive":
        return pos
    if label == "negative":
        return -neg
    return 0.0


class FinBertModel:
    """Lazy transformers-backed FinBERT. Requires the `ml` dependency-group."""

    def __init__(self, model_id: str = "ProsusAI/finbert") -> None:
        self._model_id = model_id
        self._pipeline: object | None = None

    def _ensure(self) -> object:
        if self._pipeline is None:
            try:
                from transformers import pipeline  # lazy: heavy optional-group import
            except ImportError as exc:  # pragma: no cover - exercised only without ml deps
                raise RuntimeError(
                    "FinBERT needs the 'ml' dependency-group: `uv sync --group ml`"
                ) from exc
            self._pipeline = pipeline("text-classification", model=self._model_id, top_k=None)
        return self._pipeline

    def score(self, texts: list[str]) -> list[SentimentScore]:
        pipe = self._ensure()
        raw = pipe(texts)  # type: ignore[operator]
        out: list[SentimentScore] = []
        for row in raw:
            probs = {r["label"].lower(): float(r["score"]) for r in row}
            label = max(probs, key=lambda k: probs[k])
            out.append(
                SentimentScore(label=label, score=_signed(label, probs), probabilities=probs)
            )
        return out


def score_headlines(model: SentimentModel, headlines: list[Headline]) -> list[ScoredHeadline]:
    """Score in order; each result stays bound to the original `published_at`."""
    if not headlines:
        return []
    scores = model.score([h.text for h in headlines])
    return [
        ScoredHeadline(
            id=h.id,
            published_at=h.published_at,
            text=h.text,
            sentiment=s.score,
            label=s.label,
        )
        for h, s in zip(headlines, scores, strict=True)
    ]


def point_in_time(items: list[ScoredHeadline], as_of: datetime) -> list[ScoredHeadline]:
    """Only headlines with `published_at <= as_of` — the no-look-ahead filter."""
    return [i for i in items if i.published_at <= as_of]
