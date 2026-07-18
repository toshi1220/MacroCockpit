"""日銀 時系列統計データ検索(stat-search)CSVからの取得。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float

source_ref は '{file}:{datacode}' 形式。
  例 "md01_m_1:MD01'MABS1AN11"(マネタリーベース平残・月次・億円)
     "fm01_d_1:FM01'STRDCLUCON"(無担保コールO/N・日次・年%)

パースの要点(SPEC Phase 2B 調査):
  - 固定URL https://www.stat-search.boj.or.jp/ssi/mtshtml/csv/{file}.csv(Shift-JIS)
  - r.text は使わず r.content.decode で誤判定を避ける
  - 対象列はデータコード行(第1列 "データコード")から datacode の完全一致で特定
    (列位置に依存しない。前年比系の同名+"@" 列と誤マッチしないよう完全一致)
  - データ行判定: 第1列が ^\\d{4}/\\d{2}(/\\d{2})?$。月次 YYYY/MM → YYYY-MM-01
  - 欠測は空文字 '' になり得るのでガードする
"""

from __future__ import annotations

import csv
import io
import re

import pandas as pd
import requests

BOJ_URL = "https://www.stat-search.boj.or.jp/ssi/mtshtml/csv/{file}.csv"
TIMEOUT = 30

_DATE_RE = re.compile(r"^\d{4}/\d{2}(/\d{2})?$")
_DATACODE_FIRST = "データコード"


def _to_iso(token: str) -> str:
    """'2026/06' -> '2026-06-01'。'2026/07/15' -> '2026-07-15'。"""
    parts = token.split("/")
    if len(parts) == 2:
        return f"{parts[0]}-{parts[1]}-01"
    return f"{parts[0]}-{parts[1]}-{parts[2]}"


def fetch(series) -> pd.DataFrame:
    file_code, sep, data_code = series.source_ref.partition(":")
    if not file_code or not sep or not data_code:
        raise RuntimeError(
            f"invalid boj source_ref (want '<file>:<datacode>'): {series.source_ref!r}"
        )

    url = BOJ_URL.format(file=file_code)
    resp = requests.get(url, timeout=TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(f"BOJ CSV HTTP {resp.status_code} for {file_code}")
    text = resp.content.decode("shift_jis")

    rows = list(csv.reader(io.StringIO(text)))

    # データコード行から対象列を完全一致で特定(列位置固定に依存しない)。
    col: int | None = None
    for cells in rows:
        if cells and cells[0].strip() == _DATACODE_FIRST:
            for i, c in enumerate(cells):
                if c.strip() == data_code:
                    col = i
                    break
            break
    if col is None:
        raise RuntimeError(
            f"BOJ CSV: data code {data_code!r} not found in {file_code}"
        )

    records = []
    for cells in rows:
        if not cells:
            continue
        first = cells[0].strip()
        if not _DATE_RE.match(first):
            continue
        if col >= len(cells):
            continue
        raw = cells[col].strip()
        if raw == "":  # 欠測
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        records.append({"date": _to_iso(first), "value": value})

    df = pd.DataFrame(records, columns=["date", "value"])
    return df.sort_values("date", ignore_index=True)
