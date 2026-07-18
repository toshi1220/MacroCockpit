"""registry の整合性テスト(ネットワーク不要)。

系列定義の単一の正である SERIES が、件数・一意性・列の許容値を
満たすことを検証する。系列を追加/変更したらここが最初に落ちる。
"""

from __future__ import annotations

from fetcher.registry import SERIES

_EXPECTED_COUNT = 21
_VALID_SOURCES = {"fred", "yahoo"}
_VALID_FREQS = {"D", "W", "M", "A"}


def test_series_count():
    assert len(SERIES) == _EXPECTED_COUNT


def test_series_ids_unique():
    ids = [s.series_id for s in SERIES]
    assert len(ids) == len(set(ids))


def test_sources_are_valid():
    for s in SERIES:
        assert s.source in _VALID_SOURCES, s.series_id


def test_freqs_are_valid():
    for s in SERIES:
        assert s.freq in _VALID_FREQS, s.series_id


def test_series_id_prefix_matches_source():
    """series_id の接頭辞と source が対応している(FRED:->fred, YF:->yahoo)。"""
    prefix = {"fred": "FRED:", "yahoo": "YF:"}
    for s in SERIES:
        assert s.series_id.startswith(prefix[s.source]), s.series_id
