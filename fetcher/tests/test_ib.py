"""ib ソースのテスト(fake IB オブジェクトを使用、ネットワーク不要)。"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest

from fetcher.registry import Series
from fetcher.sources import ib


def _series(source_ref: str = "ContFuture:GC:COMEX") -> Series:
    return Series(
        series_id="YF:GC=F",
        source="ib",
        source_ref=source_ref,
        name_ja="金先物",
        unit="USD",
        freq="D",
        fallback_source="yahoo",
        fallback_ref="GC=F",
    )


# --- parse_source_ref ---


def test_parse_contfuture():
    assert ib.parse_source_ref("ContFuture:GC:COMEX") == ("ContFuture", "GC", "COMEX")


def test_parse_forex():
    assert ib.parse_source_ref("Forex:USDJPY") == ("Forex", "USDJPY")


@pytest.mark.parametrize(
    "ref",
    [
        "",
        "GC=F",
        "ContFuture:GC",          # 取引所が無い
        "ContFuture:GC:COMEX:X",  # 要素過多
        "ContFuture::COMEX",      # シンボルが空
        "Forex:USD",              # 6文字ペアでない
        "Forex:USD/JPY",          # 区切り文字入り
        "Spot:GC:COMEX",          # 未知の種別
    ],
)
def test_parse_invalid_raises(ref):
    with pytest.raises(ValueError):
        ib.parse_source_ref(ref)


# --- fetch(fake IB) ---


class _Bar:
    def __init__(self, date, close):
        self.date = date
        self.close = close


class _FakeIB:
    """ib_async.IB のうち fetch が使う2メソッドだけを模す。"""

    def __init__(self, bars):
        self.bars = bars
        self.qualified = []
        self.requests = []

    def qualifyContracts(self, contract):
        self.qualified.append(contract)
        return [contract]

    def reqHistoricalData(self, contract, **kwargs):
        self.requests.append((contract, kwargs))
        return self.bars


@pytest.fixture(autouse=True)
def _no_pacing_sleep(monkeypatch):
    monkeypatch.setattr(ib.time, "sleep", lambda _s: None)  # 実待機しない


def test_fetch_converts_bars_contfuture():
    fake = _FakeIB(
        [_Bar(dt.date(2026, 7, 16), 2400.5), _Bar(dt.date(2026, 7, 17), 2410.0)]
    )

    df = ib.fetch(_series(), fake)

    assert list(df.columns) == ["date", "value"]
    assert list(df["date"]) == ["2026-07-16", "2026-07-17"]
    assert list(df["value"]) == [2400.5, 2410.0]
    assert isinstance(df.iloc[0]["value"], float)
    # ContFuture は qualify され、TRADES / useRTH=False / 日足で要求される
    assert len(fake.qualified) == 1
    contract, kwargs = fake.requests[0]
    assert contract.symbol == "GC"
    assert contract.exchange == "COMEX"
    assert kwargs["whatToShow"] == "TRADES"
    assert kwargs["useRTH"] is False
    assert kwargs["durationStr"] == "1 Y"
    assert kwargs["barSizeSetting"] == "1 day"


def test_fetch_forex_uses_idealpro_midpoint():
    fake = _FakeIB([_Bar(dt.date(2026, 7, 17), 147.25)])

    df = ib.fetch(_series("Forex:USDJPY"), fake)

    assert list(df["value"]) == [147.25]
    assert fake.qualified == []  # Forex は qualify 不要
    contract, kwargs = fake.requests[0]
    assert contract.exchange == "IDEALPRO"
    assert kwargs["whatToShow"] == "MIDPOINT"
    assert kwargs["useRTH"] is False


def test_fetch_skips_nan_close():
    fake = _FakeIB(
        [
            _Bar(dt.date(2026, 7, 15), 100.0),
            _Bar(dt.date(2026, 7, 16), float("nan")),
            _Bar(dt.date(2026, 7, 17), 102.0),
        ]
    )

    df = ib.fetch(_series(), fake)

    assert list(df["date"]) == ["2026-07-15", "2026-07-17"]


def test_fetch_empty_bars_raises():
    """タイムアウト時の空応答は例外(→ 呼び出し側がフォールバック)。"""
    fake = _FakeIB([])
    with pytest.raises(RuntimeError, match="no data returned from ib"):
        ib.fetch(_series(), fake)


def test_fetch_unqualified_contract_raises():
    fake = _FakeIB([_Bar(dt.date(2026, 7, 17), 1.0)])
    fake.qualifyContracts = lambda _c: []
    with pytest.raises(RuntimeError, match="could not qualify"):
        ib.fetch(_series(), fake)


# --- SPEC §4.4 ガードレール ---


def test_guardrail_no_order_api_in_source():
    """fetcher の全ソースに発注系APIの文字列が一切現れないこと(SPEC §4.4)。"""
    banned_tokens = (
        "placeOrder",
        "cancelOrder",
        "whatIfOrder",
        "bracketOrder",
        "reqGlobalCancel",
        "reqAutoOpenOrders",
        "MarketOrder",
        "LimitOrder",
        "StopOrder",
    )
    pkg_root = Path(ib.__file__).resolve().parents[1]  # src/fetcher/
    for py in pkg_root.rglob("*.py"):
        src = py.read_text(encoding="utf-8")
        for banned in banned_tokens:
            assert banned not in src, f"forbidden token in {py.name}: {banned}"
