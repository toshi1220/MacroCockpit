"""estat_dashboard パーサのテスト(requests をモンキーパッチしてネットワーク不要)。"""

from __future__ import annotations

from fetcher.registry import Series
from fetcher.sources import estat_dashboard as dash


def _series() -> Series:
    return Series(
        series_id="ESTATDB:REALWAGE",
        source="estat_dashboard",
        source_ref="0302030201010090010",
        name_ja="実質賃金指数",
        unit="指数",
        freq="M",
    )


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def _obj(time, val, *, seasonal="1", region="00000"):
    return {
        "VALUE": {
            "@indicator": "0302030201010090010",
            "@regionCode": region,
            "@time": time,
            "@isSeasonal": seasonal,
            "$": val,
        }
    }


def _payload(objs, status=0):
    return {
        "GET_STATS": {
            "RESULT": {"status": status, "errorMsg": "boom" if status else "OK"},
            "STATISTICAL_DATA": {"DATA_INF": {"DATA_OBJ": objs}},
        }
    }


def test_filters_seasonal_and_converts_time(monkeypatch):
    """isSeasonal=1(原数値)のみ採用し、yyyymm00 を YYYY-MM-01 に変換する。"""
    payload = _payload(
        [
            _obj("20260500", "84.3", seasonal="1"),
            _obj("20260500", "999.9", seasonal="2"),  # 季調値: 除外
            _obj("20260400", "85.2", seasonal="1"),
        ]
    )
    monkeypatch.setattr(dash.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = dash.fetch(_series())

    assert list(df.columns) == ["date", "value"]
    assert list(df["date"]) == ["2026-04-01", "2026-05-01"]
    assert df.iloc[-1]["value"] == 84.3
    assert 999.9 not in list(df["value"])  # 季調値は入らない


def test_filters_region(monkeypatch):
    """regionCode=00000(全国)以外は除外する。"""
    payload = _payload(
        [
            _obj("20260500", "84.3", region="00000"),
            _obj("20260500", "50.0", region="13000"),  # 東京都: 除外
        ]
    )
    monkeypatch.setattr(dash.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = dash.fetch(_series())

    assert list(df["value"]) == [84.3]


def test_single_object_and_status(monkeypatch):
    """DATA_OBJ 単一要素のオブジェクト化にも耐える。"""
    payload = _payload(_obj("20260500", "84.3"))  # list でなく単一 dict
    monkeypatch.setattr(dash.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = dash.fetch(_series())
    assert list(df["date"]) == ["2026-05-01"]


def test_status_nonzero_raises(monkeypatch):
    import pytest

    payload = _payload([], status=1)
    monkeypatch.setattr(dash.requests, "get", lambda *a, **k: _FakeResponse(payload))
    with pytest.raises(RuntimeError) as excinfo:
        dash.fetch(_series())
    assert "boom" in str(excinfo.value)
