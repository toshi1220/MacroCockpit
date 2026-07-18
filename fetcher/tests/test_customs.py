"""customs(税関 貿易統計CSV)パーサのテスト(requests をモンキーパッチ・ネットワーク不要)。

CSV は Shift-JIS バイト列フィクスチャで与える。ゼロ埋め将来月の除外 / 千円→億円 /
差引計算 / 末尾スペースを検証する。
"""

from __future__ import annotations

from fetcher.registry import Series
from fetcher.sources import customs


class _FakeResponse:
    def __init__(self, content: bytes, status_code=200):
        self.content = content
        self.status_code = status_code


def _series() -> Series:
    return Series(
        series_id="CUSTOMS:TRADE",
        source="customs",
        source_ref="d41ma",
        name_ja="貿易収支",
        unit="億円",
        freq="M",
    )


def _csv() -> bytes:
    # 実CSVの構造: 先頭4行ヘッダ(4行目は空), 値に末尾スペース, 将来月は "0 ,0 "。
    lines = [
        "《世界》  【月別】　（単位：千円） ,,",
        "WORLD  Monthly Data  (a thousand yen) ,,",
        "Years/Months,Exp-Total,Imp-Total",
        ",,",
        "2026/03,10981365626 ,10350131403 ",  # 差引 +6312.3 億円
        "2026/04,10506425454 ,10224099873 ",  # +2823.3
        "2026/05,9499093475 ,9890878158 ",    # -3917.8
        "2026/06,0 ,0 ",                        # 未発表(ゼロ埋め)→ 除外
        "2026/12,0 ,0 ",                        # 未発表(ゼロ埋め)→ 除外
    ]
    return ("\r\n".join(lines) + "\r\n").encode("shift_jis")


def test_balance_conversion_and_future_month_exclusion(monkeypatch):
    monkeypatch.setattr(
        customs.requests, "get", lambda *a, **k: _FakeResponse(_csv())
    )

    df = customs.fetch(_series())

    rows = dict(zip(df["date"], df["value"]))
    # 千円→億円(/100000)、差引=輸出−輸入、末尾スペース除去
    assert round(rows["2026-03-01"], 1) == 6312.3
    assert round(rows["2026-04-01"], 1) == 2823.3
    assert round(rows["2026-05-01"], 1) == -3917.8
    # 輸出入とも0の将来月は除外
    assert "2026-06-01" not in rows
    assert "2026-12-01" not in rows
    assert list(df.columns) == ["date", "value"]
    assert list(df["date"]) == sorted(df["date"])  # 昇順


def test_exact_balance_math(monkeypatch):
    """差引・単位変換が (輸出−輸入)/100000 であること。"""
    def one_row(*a, **k):
        content = (
            "h1,,\r\nh2,,\r\nYears/Months,Exp-Total,Imp-Total\r\n,,\r\n"
            "2026/05,9499093475 ,9890878158 \r\n"
        ).encode("shift_jis")
        return _FakeResponse(content)

    monkeypatch.setattr(customs.requests, "get", one_row)
    df = customs.fetch(_series())
    expected = (9499093475 - 9890878158) / 100000
    assert df.iloc[0]["value"] == expected
