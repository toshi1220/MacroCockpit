"""SQLite 入出力・スキーマ初期化。

書き込みはすべて UPSERT で冪等。何度実行しても重複・破損しない。
派生値(YoY 等)は保存しない。

一次ソースの書き込みは INSERT OR REPLACE(最新値で更新)、フォールバック
ソースの書き込みは INSERT OR IGNORE(既存日付を上書きしない)。これにより
IB 障害日にフォールバック(yfinance)が走っても、蓄積済みの IB 値は保持
される(SPEC §8「系列の重複期間は公式ソース/IBを優先」)。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# SPEC §5 の通り。毎回冪等に CREATE TABLE IF NOT EXISTS する。
SCHEMA = """
CREATE TABLE IF NOT EXISTS series (
  series_id TEXT PRIMARY KEY,   -- 例: 'FRED:DGS10'
  source    TEXT NOT NULL,      -- 'fred' | 'yahoo' | 'ib'(Phase 2 で拡張)
  name_ja   TEXT NOT NULL,
  unit      TEXT,
  freq      TEXT NOT NULL       -- 'D' | 'W' | 'M'
);

CREATE TABLE IF NOT EXISTS observations (
  series_id TEXT NOT NULL REFERENCES series(series_id),
  date      TEXT NOT NULL,      -- ISO 8601 (YYYY-MM-DD)
  value     REAL,
  PRIMARY KEY (series_id, date)
);

CREATE TABLE IF NOT EXISTS fetch_log (
  ts        TEXT NOT NULL,
  series_id TEXT NOT NULL,
  status    TEXT NOT NULL,      -- 'ok' | 'error'
  message   TEXT
);
"""


def connect(db_path) -> sqlite3.Connection:
    """DBへ接続する。親ディレクトリとスキーマが無ければ作成する(冪等)。"""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    # scheduler常駐と手動 make fetch の書き込みが重なり得るため、ロック競合は
    # 即エラーにせず最大30秒待つ(UPSERTなので待てば必ず整合する)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def upsert_series(conn: sqlite3.Connection, series) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO series (series_id, source, name_ja, unit, freq) "
        "VALUES (?, ?, ?, ?, ?)",
        (series.series_id, series.source, series.name_ja, series.unit, series.freq),
    )
    conn.commit()


def upsert_observations(
    conn: sqlite3.Connection, series_id: str, df: pd.DataFrame, *, replace: bool = True
) -> int:
    """observations へ書き込み、書き込んだ(影響した)行数を返す。

    replace=True  … INSERT OR REPLACE。一次ソース用(最新値で上書き)。
    replace=False … INSERT OR IGNORE。フォールバックソース用。既存の
                    (series_id, date) は保持し、未収録の日付だけを埋める。
                    一次ソース(IB等)で蓄積済みの値を格下げしないため。
    """
    rows = [
        (
            series_id,
            str(row.date),
            None if pd.isna(row.value) else float(row.value),
        )
        for row in df.itertuples(index=False)
    ]
    verb = "INSERT OR REPLACE" if replace else "INSERT OR IGNORE"
    cur = conn.executemany(
        f"{verb} INTO observations (series_id, date, value) VALUES (?, ?, ?)",
        rows,
    )
    conn.commit()
    # OR IGNORE では既存日付はスキップされるため、rowcount(実際に書けた行数)を返す。
    return cur.rowcount


def log_fetch(conn: sqlite3.Connection, series_id: str, status: str, message: str | None) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO fetch_log (ts, series_id, status, message) VALUES (?, ?, ?, ?)",
        (ts, series_id, status, message),
    )
    conn.commit()
