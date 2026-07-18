"""boj(日銀 stat-search CSV)パーサのテスト(requests をモンキーパッチ・ネットワーク不要)。

CSV は Shift-JIS バイト列フィクスチャで与える。先頭ヘッダ(9行)/ データコード行
(index 4)/ 空文字ガード / 月次・日次の日付変換を検証する。
"""

from __future__ import annotations

import pytest

from fetcher.registry import Series
from fetcher.sources import boj

_MB_CODE = "MD01'MABS1AN11"
_CALL_CODE = "FM01'STRDCLUCON"


class _FakeResponse:
    def __init__(self, content: bytes, status_code=200):
        self.content = content
        self.status_code = status_code


def _series(ref: str) -> Series:
    return Series(
        series_id="BOJ:X",
        source="boj",
        source_ref=ref,
        name_ja="x",
        unit="",
        freq="M",
    )


def _mb_csv() -> bytes:
    """マネタリーベース(月次)。同名 '@' 付き前年比列と平残列を並べ、列特定を試す。"""
    lines = [
        "主要時系列統計データ表",
        "2026/07/18 15:00",
        '"","マネタリーベース平均残高（月次）","マネタリーベース平均残高（月次）"',
        '"系列名称","前年比","平均残高"',
        '"データコード",' + _MB_CODE + "@," + _MB_CODE,  # index1=前年比(@), index2=平残
        '"単位",％,億円',
        '"収録開始期","1971/01","1970/01"',
        '"収録終了期","2026/06","2026/06"',
        '"最終更新日","2026/07/02","2026/07/02"',
        "1980/01,6.5,187775",
        "1980/02,6.0,",            # 空文字ガード → スキップ
        "2026/06,-13.7,5592039",
    ]
    return ("\r\n".join(lines) + "\r\n").encode("shift_jis")


def _call_csv() -> bytes:
    """無担保コールO/N(日次)。"""
    lines = [
        "主要時系列統計データ表",
        "2026/07/18 15:00",
        '"","コールレート（日次）"',
        '"系列名称","無担保コールＯ／Ｎ物レート"',
        '"データコード",' + _CALL_CODE,
        '"単位",年％',
        '"収録開始期","1998/01/05"',
        '"収録終了期","2026/07/15"',
        '"最終更新日","2026/07/17"',
        "1998/01/05,0.49",
        "2026/07/15,0.981",
    ]
    return ("\r\n".join(lines) + "\r\n").encode("shift_jis")


def test_monthly_picks_exact_datacode_column(monkeypatch):
    """月次: '@' 付き同名列でなく完全一致の平残列を選び、YYYY/MM を変換する。"""
    monkeypatch.setattr(
        boj.requests, "get", lambda *a, **k: _FakeResponse(_mb_csv())
    )

    df = boj.fetch(_series("md01_m_1:" + _MB_CODE))

    rows = dict(zip(df["date"], df["value"]))
    assert rows["1980-01-01"] == 187775.0  # 前年比 6.5 ではなく平残を選ぶ
    assert rows["2026-06-01"] == 5592039.0
    assert "1980-02-01" not in rows  # 空文字はスキップ
    assert list(df.columns) == ["date", "value"]


def test_daily_date_conversion(monkeypatch):
    """日次: YYYY/MM/DD をそのまま ISO 日付へ。"""
    monkeypatch.setattr(
        boj.requests, "get", lambda *a, **k: _FakeResponse(_call_csv())
    )

    df = boj.fetch(_series("fm01_d_1:" + _CALL_CODE))

    rows = dict(zip(df["date"], df["value"]))
    assert rows["1998-01-05"] == 0.49
    assert rows["2026-07-15"] == 0.981


def test_unknown_datacode_raises(monkeypatch):
    monkeypatch.setattr(
        boj.requests, "get", lambda *a, **k: _FakeResponse(_mb_csv())
    )
    with pytest.raises(RuntimeError, match="not found"):
        boj.fetch(_series("md01_m_1:NOSUCHCODE"))


def test_invalid_source_ref_raises():
    with pytest.raises(RuntimeError):
        boj.fetch(_series("nocolon"))
