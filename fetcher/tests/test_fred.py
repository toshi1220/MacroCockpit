"""fred パーサのテスト(requests をモンキーパッチしてネットワーク不要)。"""

from __future__ import annotations

import pytest

from fetcher.registry import Series
from fetcher.sources import fred


def _series() -> Series:
    return Series(
        series_id="FRED:DGS10",
        source="fred",
        source_ref="DGS10",
        name_ja="米10年金利",
        unit="%",
        freq="D",
    )


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def test_fetch_parses_json(monkeypatch):
    payload = {
        "observations": [
            {"date": "2020-01-01", "value": "1.5"},
            {"date": "2020-01-02", "value": "1.6"},
        ]
    }
    monkeypatch.setenv("FRED_API_KEY", "dummy")
    monkeypatch.setattr(fred.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = fred.fetch(_series())

    assert list(df.columns) == ["date", "value"]
    assert len(df) == 2
    assert df.iloc[0]["date"] == "2020-01-01"
    assert df.iloc[0]["value"] == 1.5
    assert isinstance(df.iloc[0]["value"], float)


def test_fetch_skips_missing_dot(monkeypatch):
    payload = {
        "observations": [
            {"date": "2020-01-01", "value": "."},
            {"date": "2020-01-02", "value": "2.0"},
        ]
    }
    monkeypatch.setenv("FRED_API_KEY", "dummy")
    monkeypatch.setattr(fred.requests, "get", lambda *a, **k: _FakeResponse(payload))

    df = fred.fetch(_series())

    assert len(df) == 1
    assert df.iloc[0]["date"] == "2020-01-02"
    assert df.iloc[0]["value"] == 2.0


def test_fetch_requires_api_key(monkeypatch):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        fred.fetch(_series())


def test_fetch_http_error_does_not_leak_api_key(monkeypatch):
    monkeypatch.setenv("FRED_API_KEY", "SECRETKEY123")
    monkeypatch.setattr(
        fred.requests, "get", lambda *a, **k: _FakeResponse({}, status_code=429)
    )

    with pytest.raises(RuntimeError) as excinfo:
        fred.fetch(_series())

    assert "429" in str(excinfo.value)
    assert "SECRETKEY123" not in str(excinfo.value)
