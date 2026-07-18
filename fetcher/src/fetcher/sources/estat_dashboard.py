"""統計ダッシュボードAPI(dashboard.e-stat.go.jp)からの取得。実質賃金指数など。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float

e-Stat API 本体には現行基準(2020年=100)の毎月勤労統計が未登録(全表2021年で
停止)のため、公式の統計ダッシュボードAPIを使う。appId は不要。

source_ref は IndicatorCode。例 '0302030201010090010'(実質賃金指数・月次)。

落とし穴(実データで確認済み・SPEC Phase 2B 調査):
  - 各要素は {"VALUE": {...}}。同一 time に季調値が混在する
  - @isSeasonal "1"=原数値のみ採用("2"=季調値は除外)
  - @regionCode "00000"(全国)のみ採用
  - @time は yyyymm00 形式(例 20260500=2026年5月)
"""

from __future__ import annotations

import pandas as pd
import requests

DASHBOARD_URL = "https://dashboard.e-stat.go.jp/api/1.0/Json/getData"
TIMEOUT = 30
_MISSING = {"***", "-", ""}


def _as_list(node):
    """要素1個のときオブジェクト化する系のノードを常にリストへ正規化する。"""
    if node is None:
        return []
    if isinstance(node, list):
        return node
    return [node]


def fetch(series) -> pd.DataFrame:
    params = {
        "Lang": "JP",
        "IndicatorCode": series.source_ref,
        "Cycle": "1",  # 月次
    }
    resp = requests.get(DASHBOARD_URL, params=params, timeout=TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(
            f"e-Stat dashboard HTTP {resp.status_code} for indicator {series.source_ref}"
        )
    payload = resp.json()

    gs = payload.get("GET_STATS", {}) or {}
    result = gs.get("RESULT", {}) or {}
    status = str(result.get("status"))
    if status != "0":
        raise RuntimeError(
            f"e-Stat dashboard error status={status} for indicator {series.source_ref}: "
            f"{result.get('errorMsg')}"
        )

    objs = _as_list(
        gs.get("STATISTICAL_DATA", {}).get("DATA_INF", {}).get("DATA_OBJ")
    )

    records = []
    for obj in objs:
        if not isinstance(obj, dict):
            continue
        v = obj.get("VALUE")
        if not isinstance(v, dict):
            continue
        if v.get("@isSeasonal") != "1":  # 原数値のみ(季調値 "2" は除外)
            continue
        if v.get("@regionCode") != "00000":  # 全国のみ
            continue
        t = str(v.get("@time", ""))
        if len(t) < 6:
            continue
        year, month = t[0:4], t[4:6]
        if not ("01" <= month <= "12"):  # 年計等の紛れ込みを除外
            continue
        raw = v.get("$")
        if raw is None or str(raw) in _MISSING:
            continue
        records.append({"date": f"{year}-{month}-01", "value": float(raw)})

    df = pd.DataFrame(records, columns=["date", "value"])
    return df.sort_values("date", ignore_index=True)
