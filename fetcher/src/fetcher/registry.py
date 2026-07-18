"""系列定義の単一の正 (single source of truth)。

系列の追加・変更はこのファイルだけで行う。Phase 1 では SERIES に
エントリを追加するだけで取得対象が増える構造にしてある。

series_id は 'FRED:<ref>' / 'YF:<ref>' の形式。source は 'fred' | 'yahoo' | 'ib'。
freq は 'D' | 'W' | 'M' | 'A'(SPEC のスキーマコメントは D/W/M だが、
生きた月次日本CPIが FRED に存在しないため年次代替 FPCPITOTLZGJPN を採用し
'A' を許容する。経緯は README.md 参照)。

Phase 2 で先物・FXの一次ソースを IB に切り替えた(SPEC §4.4)。該当5系列は
source='ib' だが、**series_id はデータ継続性のため 'YF:...' のまま変更しない**
(observations に蓄積済みの系列IDを維持する。README の注記参照)。
fallback_source / fallback_ref があれば、IB 接続・取得の失敗時に main が
そのソースへ自動フォールバックする。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Series:
    series_id: str      # DB上の一意ID 例: 'FRED:DGS10'
    source: str         # 'fred' | 'yahoo' | 'ib'
    source_ref: str     # ソース側のシリーズID 例: 'DGS10', 'ContFuture:GC:COMEX'
    name_ja: str        # 表示名(日本語)
    unit: str | None    # '%', '円', 'USD' など
    freq: str           # 'D' | 'W' | 'M' | 'A'
    fallback_source: str | None = None  # 一次ソース失敗時のソース 例: 'yahoo'
    fallback_ref: str | None = None     # フォールバック側のシリーズID 例: 'GC=F'


# SPEC §4.1 の全系列。要確認だった系列は FRED API で実在検証済み。
# - 日本CPI: JPNCPIALLMINMEI は 2021-06 で更新停止(OECD系列廃止)のため、
#   世界銀行の年次系列 FPCPITOTLZGJPN(前年比%)を代替採用。月次は Phase 2 で e-Stat。
# - DTWEXBGS: FRED メタデータ上の実頻度は Daily(SPEC は週次と記載だが実データは日次)。
# - JPY=X: DEXJPUS(FRED)を USD/JPY の正とし、yfinance は補助。
SERIES: list[Series] = [
    # --- FRED ---
    Series(
        series_id="FRED:CPIAUCSL",
        source="fred",
        source_ref="CPIAUCSL",
        name_ja="米CPI",
        unit="指数",
        freq="M",
    ),
    Series(
        series_id="FRED:FPCPITOTLZGJPN",
        source="fred",
        source_ref="FPCPITOTLZGJPN",
        name_ja="日本CPI(年次)",
        unit="%",
        freq="A",
    ),
    Series(
        series_id="FRED:T10YIE",
        source="fred",
        source_ref="T10YIE",
        name_ja="米10年BEI",
        unit="%",
        freq="D",
    ),
    Series(
        series_id="FRED:DGS10",
        source="fred",
        source_ref="DGS10",
        name_ja="米10年金利",
        unit="%",
        freq="D",
    ),
    Series(
        series_id="FRED:IRLTLT01JPM156N",
        source="fred",
        source_ref="IRLTLT01JPM156N",
        name_ja="日本10年金利",
        unit="%",
        freq="M",
    ),
    Series(
        series_id="FRED:DFII10",
        source="fred",
        source_ref="DFII10",
        name_ja="米10年実質金利",
        unit="%",
        freq="D",
    ),
    Series(
        series_id="FRED:DEXJPUS",
        source="fred",
        source_ref="DEXJPUS",
        name_ja="USD/JPY",
        unit="円",
        freq="D",
    ),
    Series(
        series_id="FRED:DTWEXBGS",
        source="fred",
        source_ref="DTWEXBGS",
        name_ja="ドル実効指数",
        unit="指数",
        freq="D",
    ),
    Series(
        series_id="FRED:WALCL",
        source="fred",
        source_ref="WALCL",
        name_ja="Fed総資産",
        unit="百万ドル",
        freq="W",
    ),
    Series(
        series_id="FRED:JPNASSETS",
        source="fred",
        source_ref="JPNASSETS",
        name_ja="日銀総資産",
        unit="億円",
        freq="M",
    ),
    Series(
        series_id="FRED:BAMLH0A0HYM2",
        source="fred",
        source_ref="BAMLH0A0HYM2",
        name_ja="米HY社債スプレッド",
        unit="%",
        freq="D",
    ),
    Series(
        series_id="FRED:CSUSHPISA",
        source="fred",
        source_ref="CSUSHPISA",
        name_ja="米住宅価格CS",
        unit="指数",
        freq="M",
    ),
    # --- IB 一次(フォールバック: Yahoo Finance)---
    # series_id は蓄積データの継続性のため 'YF:' 接頭辞のまま(README 注記)。
    Series(
        series_id="YF:GC=F",
        source="ib",
        source_ref="ContFuture:GC:COMEX",
        name_ja="金先物",
        unit="USD",
        freq="D",
        fallback_source="yahoo",
        fallback_ref="GC=F",
    ),
    Series(
        series_id="YF:CL=F",
        source="ib",
        source_ref="ContFuture:CL:NYMEX",
        name_ja="WTI原油",
        unit="USD",
        freq="D",
        fallback_source="yahoo",
        fallback_ref="CL=F",
    ),
    Series(
        series_id="YF:HG=F",
        source="ib",
        source_ref="ContFuture:HG:COMEX",
        name_ja="銅先物",
        unit="USD",
        freq="D",
        fallback_source="yahoo",
        fallback_ref="HG=F",
    ),
    Series(
        series_id="YF:NG=F",
        source="ib",
        source_ref="ContFuture:NG:NYMEX",
        name_ja="天然ガス",
        unit="USD",
        freq="D",
        fallback_source="yahoo",
        fallback_ref="NG=F",
    ),
    # --- Yahoo Finance ---
    Series(
        series_id="YF:^N225",
        source="yahoo",
        source_ref="^N225",
        name_ja="日経225",
        unit="pt",
        freq="D",
    ),
    Series(
        series_id="YF:^GSPC",
        source="yahoo",
        source_ref="^GSPC",
        name_ja="S&P500",
        unit="pt",
        freq="D",
    ),
    Series(
        series_id="YF:^VIX",
        source="yahoo",
        source_ref="^VIX",
        name_ja="VIX",
        unit="pt",
        freq="D",
    ),
    Series(
        series_id="YF:1343.T",
        source="yahoo",
        source_ref="1343.T",
        name_ja="東証REIT",
        unit="円",
        freq="D",
    ),
    Series(
        series_id="YF:JPY=X",
        source="ib",
        source_ref="Forex:USDJPY",
        name_ja="USD/JPY(補助)",
        unit="円",
        freq="D",
        fallback_source="yahoo",
        fallback_ref="JPY=X",
    ),
]
