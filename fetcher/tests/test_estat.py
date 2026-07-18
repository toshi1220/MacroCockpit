"""estat パーサのテスト(requests をモンキーパッチしてネットワーク不要)。"""

from __future__ import annotations

import pytest

from fetcher.registry import Series
from fetcher.sources import estat


def _series() -> Series:
    return Series(
        series_id="ESTAT:CPI_JP",
        source="estat",
        source_ref="0003427113:1:0001:00000",
        name_ja="日本CPI(月次)",
        unit="指数",
        freq="M",
    )


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def _payload(values, status=0):
    return {
        "GET_STATS_DATA": {
            "RESULT": {"STATUS": status, "ERROR_MSG": "boom" if status else "OK"},
            "STATISTICAL_DATA": {"DATA_INF": {"VALUE": values}},
        }
    }


def _v(time, val):
    return {"@tab": "1", "@cat01": "0001", "@area": "00000", "@time": time, "$": val}


def test_fetch_parses_monthly(monkeypatch):
    payload = _payload(
        [_v("2026000505", "113.5"), _v("2026000404", "113.0"), _v("2026000303", "112.7")]
    )
    monkeypatch.setenv("ESTAT_APP_ID", "dummy")
    monkeypatch.setattr(estat.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = estat.fetch(_series())

    assert list(df.columns) == ["date", "value"]
    assert len(df) == 3
    # 昇順に整列される
    assert list(df["date"]) == ["2026-03-01", "2026-04-01", "2026-05-01"]
    assert df.iloc[-1]["value"] == 113.5
    assert isinstance(df.iloc[-1]["value"], float)


def test_fetch_single_value_object(monkeypatch):
    """全ノードは要素1個だとリストでなくオブジェクトになる → 両対応。"""
    payload = _payload(_v("2026000505", "113.5"))  # list でなく単一 dict
    monkeypatch.setenv("ESTAT_APP_ID", "dummy")
    monkeypatch.setattr(estat.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = estat.fetch(_series())

    assert len(df) == 1
    assert df.iloc[0]["date"] == "2026-05-01"
    assert df.iloc[0]["value"] == 113.5


def test_fetch_skips_missing_stars(monkeypatch):
    """欠損は "$" が "***"。"""
    payload = _payload([_v("2026000505", "113.5"), _v("2026000404", "***")])
    monkeypatch.setenv("ESTAT_APP_ID", "dummy")
    monkeypatch.setattr(estat.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = estat.fetch(_series())

    assert len(df) == 1
    assert df.iloc[0]["date"] == "2026-05-01"


def test_fetch_excludes_annual_code(monkeypatch):
    """年計 YYYY000000 は後方参照正規表現に一致するが月次ではない → 除外。"""
    payload = _payload(
        [_v("2026000505", "113.5"), _v("2025000000", "109.9"), _v("2020000000", "100.0")]
    )
    monkeypatch.setenv("ESTAT_APP_ID", "dummy")
    monkeypatch.setattr(estat.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = estat.fetch(_series())

    assert list(df["date"]) == ["2026-05-01"]  # 年計は除外され月次のみ


def test_fetch_status_nonzero_raises(monkeypatch):
    payload = _payload([], status=1)
    monkeypatch.setenv("ESTAT_APP_ID", "dummy")
    monkeypatch.setattr(estat.requests, "get", lambda *a, **k: _FakeResponse(payload))

    with pytest.raises(RuntimeError) as excinfo:
        estat.fetch(_series())
    assert "STATUS=1" in str(excinfo.value)
    assert "boom" in str(excinfo.value)  # ERROR_MSG 付き


def test_fetch_requires_app_id(monkeypatch):
    monkeypatch.delenv("ESTAT_APP_ID", raising=False)
    with pytest.raises(RuntimeError):
        estat.fetch(_series())


def test_fetch_http_error_does_not_leak_app_id(monkeypatch):
    monkeypatch.setenv("ESTAT_APP_ID", "SECRETAPPID")
    monkeypatch.setattr(
        estat.requests, "get", lambda *a, **k: _FakeResponse({}, status_code=500)
    )
    with pytest.raises(RuntimeError) as excinfo:
        estat.fetch(_series())
    assert "500" in str(excinfo.value)
    assert "SECRETAPPID" not in str(excinfo.value)
