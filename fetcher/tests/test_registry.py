"""registry の整合性テスト(ネットワーク不要)。

系列定義の単一の正である SERIES が、件数・一意性・列の許容値を
満たすことを検証する。系列を追加/変更したらここが最初に落ちる。
"""

from __future__ import annotations

from fetcher.registry import SERIES

_EXPECTED_COUNT = 21
_VALID_SOURCES = {"fred", "yahoo", "ib"}
_VALID_FREQS = {"D", "W", "M", "A"}
# Phase 2 で一次ソースを IB に切り替えた系列(series_id はデータ継続性のため据え置き)
_IB_SERIES_IDS = {"YF:GC=F", "YF:CL=F", "YF:HG=F", "YF:NG=F", "YF:JPY=X"}


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
    """series_id の接頭辞と source が対応している(FRED:->fred, YF:->yahoo)。

    Phase 2 で source='ib' になった旧 Yahoo 系列は、蓄積データの継続性のため
    series_id を 'YF:' のまま据え置いている(README 注記)。
    """
    prefix = {"fred": "FRED:", "yahoo": "YF:", "ib": "YF:"}
    for s in SERIES:
        assert s.series_id.startswith(prefix[s.source]), s.series_id


def test_ib_series_have_yahoo_fallback():
    """IB一次の5系列は yahoo フォールバックを持ち、それ以外は持たない。"""
    ib_ids = {s.series_id for s in SERIES if s.source == "ib"}
    assert ib_ids == _IB_SERIES_IDS
    for s in SERIES:
        if s.source == "ib":
            assert s.fallback_source == "yahoo", s.series_id
            assert s.fallback_ref, s.series_id
        else:
            assert s.fallback_source is None, s.series_id
            assert s.fallback_ref is None, s.series_id
