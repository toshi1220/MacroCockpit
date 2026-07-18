"""e-Stat API(政府統計の総合窓口)からの取得。日本CPI 月次など。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float

source_ref は 'statsDataId:cdTab:cdCat01:cdArea' 形式。
  例 '0003427113:1:0001:00000'(消費者物価指数・2020年基準・全国・総合)

appId は環境変数 ESTAT_APP_ID。未設定なら明確な RuntimeError を投げる。
appId はURLパラメータに載るため、requests の通信例外(ConnectionError 等)の
文字列に混入しうる。呼び出し側(main.sanitize)が appId=... をマスクする。

落とし穴(実データで確認済み・SPEC Phase 2B 調査):
  1. 全ノードは要素1個だとリストでなくオブジェクトになる → array/object 両対応
  2. 欠損は "$" が "***"
  3. 月次 time コードは YYYY00MMMM(例 2026000505=2026年5月)。ただし年計
     YYYY000000 も後方参照つき正規表現に一致してしまうため、月 "00" を除外する
"""

from __future__ import annotations

import os
import re

import pandas as pd
import requests

ESTAT_URL = "https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData"
TIMEOUT = 30

# 月次 time コード YYYY00MMMM(末尾2桁対が一致)。group(1)=年 / group(2)=月。
# 年計 YYYY000000 も一致する(month=='00')ため、下で月 "00" を除外する。
_MONTHLY_RE = re.compile(r"^(\d{4})00(\d{2})\2$")
_MISSING = {"***", "-", ""}


def _as_list(node):
    """e-Stat の全ノードは要素1個だとオブジェクトになる。常にリストに正規化する。"""
    if node is None:
        return []
    if isinstance(node, list):
        return node
    return [node]


def fetch(series) -> pd.DataFrame:
    app_id = os.environ.get("ESTAT_APP_ID")
    if not app_id:
        raise RuntimeError(
            "ESTAT_APP_ID is not set. Copy .env.example to .env and set your e-Stat appId."
        )

    parts = series.source_ref.split(":")
    if len(parts) != 4:
        raise RuntimeError(
            f"invalid estat source_ref (want statsDataId:cdTab:cdCat01:cdArea): "
            f"{series.source_ref!r}"
        )
    stats_data_id, cd_tab, cd_cat01, cd_area = parts

    params = {
        "appId": app_id,
        "statsDataId": stats_data_id,
        "cdTab": cd_tab,
        "cdCat01": cd_cat01,
        "cdArea": cd_area,
    }
    resp = requests.get(ESTAT_URL, params=params, timeout=TIMEOUT)
    # raise_for_status() は使わない: HTTPError の str() が appId 入り完全URLになり
    # fetch_log(DB)へ永続化される。appId を含まない例外に留める。
    if resp.status_code != 200:
        raise RuntimeError(
            f"e-Stat API HTTP {resp.status_code} for statsDataId {stats_data_id}"
        )
    payload = resp.json()

    gsd = payload.get("GET_STATS_DATA", {}) or {}
    result = gsd.get("RESULT", {}) or {}
    status = str(result.get("STATUS"))
    if status != "0":
        # ERROR_MSG に appId は含まれない(e-Stat 仕様)。
        raise RuntimeError(
            f"e-Stat API error STATUS={status} for statsDataId {stats_data_id}: "
            f"{result.get('ERROR_MSG')}"
        )

    values = _as_list(
        gsd.get("STATISTICAL_DATA", {}).get("DATA_INF", {}).get("VALUE")
    )

    records = []
    for v in values:
        if not isinstance(v, dict):
            continue
        m = _MONTHLY_RE.match(str(v.get("@time", "")))
        if not m:
            continue
        year, month = m.group(1), m.group(2)
        if month == "00":  # 年計(月次コードに紛れる)は除外
            continue
        raw = v.get("$")
        if raw is None or str(raw) in _MISSING:  # 欠損 "***" 等はスキップ
            continue
        records.append({"date": f"{year}-{month}-01", "value": float(raw)})

    df = pd.DataFrame(records, columns=["date", "value"])
    return df.sort_values("date", ignore_index=True)
