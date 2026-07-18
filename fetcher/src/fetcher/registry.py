"""系列定義の単一の正 (single source of truth)。

系列の追加・変更はこのファイルだけで行う。Phase 1 では SERIES に
エントリを追加するだけで取得対象が増える構造にしてある。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Series:
    series_id: str      # DB上の一意ID 例: 'FRED:DGS10'
    source: str         # 'fred' | 'yahoo'
    source_ref: str     # ソース側のシリーズID 例: 'DGS10'
    name_ja: str        # 表示名(日本語)
    unit: str | None    # '%', '円', 'USD' など
    freq: str           # 'D' | 'W' | 'M'


# Phase 0 は DGS10 の1系列のみ。Phase 1 で §4.1 の全系列をここに追加する。
SERIES: list[Series] = [
    Series(
        series_id="FRED:DGS10",
        source="fred",
        source_ref="DGS10",
        name_ja="米10年金利",
        unit="%",
        freq="D",
    ),
]
