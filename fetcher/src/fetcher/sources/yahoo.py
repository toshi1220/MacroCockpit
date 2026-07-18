"""Yahoo Finance (yfinance) からの取得。

共通インターフェース: fetch(series) -> pandas.DataFrame(columns=[date, value])
  - date:  str (ISO 8601, YYYY-MM-DD)
  - value: float
Close 列を値として使う。NaN 行はスキップする。

yfinance は非公式APIで壊れやすい(レート制限・空応答)。取得に失敗した
場合は 1 回だけ(2秒待って)リトライする。yfinance の例外メッセージには
秘密情報が含まれないため、2回目の失敗はそのまま送出してよい。
SPEC §4.3 の通り、将来 stooq / IB 等へ差し替え可能なよう抽象化してある。
"""

from __future__ import annotations

import time

import pandas as pd
import yfinance as yf

RETRY_WAIT = 2  # seconds


def _download(source_ref: str) -> pd.DataFrame:
    """yfinance から日足を取得する。空応答は失敗として例外にする。"""
    ticker = yf.Ticker(source_ref)
    raw = ticker.history(period="max", interval="1d", auto_adjust=False)
    if raw is None or raw.empty or "Close" not in raw.columns:
        raise RuntimeError(f"no data returned from yahoo for {source_ref}")
    return raw


def fetch(series) -> pd.DataFrame:
    try:
        raw = _download(series.source_ref)
    except Exception:
        # yfinance は不安定なので 1 回だけリトライする。
        time.sleep(RETRY_WAIT)
        raw = _download(series.source_ref)  # 2回目の失敗はそのまま送出

    records = []
    for ts, value in raw["Close"].items():
        if pd.isna(value):  # 休場日などの NaN 行はスキップ
            continue
        records.append({"date": ts.strftime("%Y-%m-%d"), "value": float(value)})

    return pd.DataFrame(records, columns=["date", "value"])
