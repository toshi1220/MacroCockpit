"""FRED からの取得。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float
FRED の欠損値 "." は行ごとスキップする。
"""

from __future__ import annotations

import os

import pandas as pd
import requests

FRED_URL = "https://api.stlouisfed.org/fred/series/observations"
TIMEOUT = 30


def fetch(series) -> pd.DataFrame:
    api_key = os.environ.get("FRED_API_KEY")
    if not api_key:
        raise RuntimeError(
            "FRED_API_KEY is not set. Copy .env.example to .env and set your FRED API key."
        )

    params = {
        "series_id": series.source_ref,
        "api_key": api_key,
        "file_type": "json",
    }
    resp = requests.get(FRED_URL, params=params, timeout=TIMEOUT)
    # raise_for_status() は禁止: HTTPError の str() が api_key 入りの完全URLに
    # なり、fetch_log(DB)へ永続化されてしまう。キーを含まない例外を投げる。
    if resp.status_code != 200:
        raise RuntimeError(
            f"FRED API error {resp.status_code} for series {series.source_ref}"
        )
    payload = resp.json()

    records = []
    for obs in payload.get("observations", []):
        raw = obs.get("value")
        if raw is None or raw == ".":  # FRED の欠損はドット
            continue
        records.append({"date": obs["date"], "value": float(raw)})

    return pd.DataFrame(records, columns=["date", "value"])
