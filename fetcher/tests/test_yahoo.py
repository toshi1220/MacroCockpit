"""yahoo パーサのテスト(yfinance をモンキーパッチしてネットワーク不要)。"""

from __future__ import annotations

import pandas as pd

from fetcher.registry import Series
from fetcher.sources import yahoo


def _series() -> Series:
    return Series(
        series_id="YF:GC=F",
        source="yahoo",
        source_ref="GC=F",
        name_ja="金先物",
        unit="USD",
        freq="D",
    )


def _history(dates, closes) -> pd.DataFrame:
    """yfinance の history() が返す形(DatetimeIndex + Close 列)を模す。"""
    idx = pd.to_datetime(dates)
    return pd.DataFrame({"Open": closes, "Close": closes}, index=idx)


class _FakeTicker:
    def __init__(self, ref):
        self.ref = ref

    def history(self, **kwargs):  # noqa: ARG002 - 引数は無視して固定応答
        return _history(
            ["2026-07-16", "2026-07-17"],
            [2400.5, 2410.0],
        )


def test_fetch_converts_close(monkeypatch):
    monkeypatch.setattr(yahoo.yf, "Ticker", _FakeTicker)

    df = yahoo.fetch(_series())

    assert list(df.columns) == ["date", "value"]
    assert len(df) == 2
    assert df.iloc[0]["date"] == "2026-07-16"
    assert df.iloc[0]["value"] == 2400.5
    assert isinstance(df.iloc[0]["value"], float)


def test_fetch_skips_nan(monkeypatch):
    class _NanTicker:
        def __init__(self, ref):
            self.ref = ref

        def history(self, **kwargs):  # noqa: ARG002
            return _history(
                ["2026-07-15", "2026-07-16", "2026-07-17"],
                [100.0, float("nan"), 102.0],
            )

    monkeypatch.setattr(yahoo.yf, "Ticker", _NanTicker)

    df = yahoo.fetch(_series())

    assert len(df) == 2
    assert list(df["date"]) == ["2026-07-15", "2026-07-17"]
    assert list(df["value"]) == [100.0, 102.0]


def test_fetch_retries_once_on_failure(monkeypatch):
    calls = {"n": 0}

    class _FlakyTicker:
        def __init__(self, ref):
            self.ref = ref

        def history(self, **kwargs):  # noqa: ARG002
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("YFRateLimitError: too many requests")
            return _history(["2026-07-16", "2026-07-17"], [1.0, 2.0])

    monkeypatch.setattr(yahoo.yf, "Ticker", _FlakyTicker)
    monkeypatch.setattr(yahoo.time, "sleep", lambda _s: None)  # 実待機しない

    df = yahoo.fetch(_series())

    assert calls["n"] == 2  # 1回目失敗 → リトライで成功
    assert len(df) == 2
    assert df.iloc[1]["value"] == 2.0
