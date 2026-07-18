"""mof(財務省 国債金利CSV)パーサのテスト(requests をモンキーパッチ・ネットワーク不要)。

CSV は Shift-JIS(cp932)バイト列フィクスチャで与える。
"""

from __future__ import annotations

import pytest

from fetcher.registry import Series
from fetcher.sources import mof

_LABELS = [
    "1年", "2年", "3年", "4年", "5年", "6年", "7年", "8年", "9年",
    "10年", "15年", "20年", "25年", "30年", "40年",
]
_HEADER = "基準日," + ",".join(_LABELS)


def _series(ref: str = "jgb:10") -> Series:
    return Series(
        series_id="MOF:JGB10Y",
        source="mof",
        source_ref=ref,
        name_ja="日本10年金利(日次)",
        unit="%",
        freq="D",
    )


def _row(date: str, values: dict[str, str]) -> str:
    """欠損は '-'(実CSVと同じ)。values は {ラベル: 値文字列}。"""
    cols = [date] + [values.get(lbl, "-") for lbl in _LABELS]
    return ",".join(cols)


def _csv(rows: list[str]) -> bytes:
    title = "国債金利情報," + "," * 14 + "(単位 : %)"
    return ("\r\n".join([title, _HEADER, *rows]) + "\r\n").encode("cp932")


class _FakeResponse:
    def __init__(self, content: bytes, status_code=200):
        self.content = content
        self.status_code = status_code


def _fake_get(all_csv: bytes, cur_csv: bytes | None, *, cur_status=200):
    def get(url, *a, **k):
        if url == mof.MOF_ALL_URL:
            return _FakeResponse(all_csv)
        if cur_csv is None:
            return _FakeResponse(b"", status_code=cur_status)
        return _FakeResponse(cur_csv)
    return get


def test_wareki_boundaries_and_shift_jis(monkeypatch):
    """S/H/R 境界の和暦変換 + Shift-JIS デコード。"""
    all_csv = _csv(
        [
            _row("S64.1.6", {"10年": "2.500"}),   # 1925+64 = 1989
            _row("H31.1.4", {"10年": "-0.010"}),  # 1988+31 = 2019
            _row("R8.6.30", {"10年": "2.690"}),   # 2018+8  = 2026
        ]
    )
    cur_csv = _csv([_row("R8.7.16", {"10年": "2.719"})])
    monkeypatch.setattr(mof.requests, "get", _fake_get(all_csv, cur_csv))

    df = mof.fetch(_series("jgb:10"))

    rows = dict(zip(df["date"], df["value"]))
    assert rows["1989-01-06"] == 2.500
    assert rows["2019-01-04"] == -0.010
    assert rows["2026-06-30"] == 2.690
    assert rows["2026-07-16"] == 2.719
    assert list(df["date"]) == sorted(df["date"])  # 昇順


def test_missing_dash_vs_negative_rate(monkeypatch):
    """欠損は厳密に '-' のフィールドのみ。マイナス金利 '-0.173' は値として採用。"""
    all_csv = _csv(
        [
            _row("H31.1.4", {"10年": "-0.173"}),  # マイナス金利: 採用
            _row("R8.6.29", {"10年": "-"}),       # 欠損: スキップ
            _row("R8.6.30", {"10年": "2.690"}),
        ]
    )
    monkeypatch.setattr(mof.requests, "get", _fake_get(all_csv, _csv([])))

    df = mof.fetch(_series("jgb:10"))
    rows = dict(zip(df["date"], df["value"]))

    assert rows["2019-01-04"] == -0.173  # 先頭 '-' でも値として残る
    assert "2026-06-29" not in rows       # '-' 単独は欠損として除外
    assert rows["2026-06-30"] == 2.690


def test_union_prefers_current_month(monkeypatch):
    """重複日は当月分(jgbcm.csv)を優先する。"""
    all_csv = _csv([_row("R8.6.30", {"10年": "2.690"})])
    cur_csv = _csv(
        [
            _row("R8.6.30", {"10年": "9.999"}),  # 同一日を当月分が上書き
            _row("R8.7.16", {"10年": "2.719"}),
        ]
    )
    monkeypatch.setattr(mof.requests, "get", _fake_get(all_csv, cur_csv))

    df = mof.fetch(_series("jgb:10"))
    rows = dict(zip(df["date"], df["value"]))

    assert rows["2026-06-30"] == 9.999  # 当月分優先
    assert rows["2026-07-16"] == 2.719


def test_current_month_failure_uses_full_history(monkeypatch):
    """当月分の取得失敗は全履歴だけで続行する(例外を投げない)。"""
    all_csv = _csv([_row("R8.6.30", {"10年": "2.690"})])
    monkeypatch.setattr(
        mof.requests, "get", _fake_get(all_csv, None, cur_status=500)
    )

    df = mof.fetch(_series("jgb:10"))
    rows = dict(zip(df["date"], df["value"]))

    assert rows == {"2026-06-30": 2.690}  # 全履歴のみ


def test_column_selected_by_year_label(monkeypatch):
    """ref 'jgb:30' は '30年' 列(index 14)を選ぶ(列位置非依存)。"""
    all_csv = _csv([_row("R8.6.30", {"10年": "2.690", "30年": "3.873"})])
    monkeypatch.setattr(mof.requests, "get", _fake_get(all_csv, _csv([])))

    df = mof.fetch(_series("jgb:30"))
    assert dict(zip(df["date"], df["value"])) == {"2026-06-30": 3.873}


def test_invalid_source_ref_raises(monkeypatch):
    with pytest.raises(RuntimeError):
        mof.fetch(_series("bogus"))
