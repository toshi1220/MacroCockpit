"""SQLite 入出力・スキーマ初期化。

書き込みはすべて UPSERT (INSERT OR REPLACE) で冪等。何度実行しても
重複・破損しない。派生値(YoY 等)は保存しない。
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
  source    TEXT NOT NULL,      -- 'fred' | 'yahoo'
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


def upsert_observations(conn: sqlite3.Connection, series_id: str, df: pd.DataFrame) -> int:
    """observations に INSERT OR REPLACE する。挿入した行数を返す。"""
    rows = [
        (
            series_id,
            str(row.date),
            None if pd.isna(row.value) else float(row.value),
        )
        for row in df.itertuples(index=False)
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO observations (series_id, date, value) VALUES (?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(rows)


def log_fetch(conn: sqlite3.Connection, series_id: str, status: str, message: str | None) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO fetch_log (ts, series_id, status, message) VALUES (?, ?, ?, ?)",
        (ts, series_id, status, message),
    )
    conn.commit()
