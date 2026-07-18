"""store のテスト(ネットワーク不要)。"""

from __future__ import annotations

import pandas as pd

from fetcher import store
from fetcher.registry import Series


def _series() -> Series:
    return Series(
        series_id="FRED:TEST",
        source="fred",
        source_ref="TEST",
        name_ja="テスト系列",
        unit="%",
        freq="D",
    )


def test_upsert_is_idempotent(tmp_path):
    """同一データを2回 upsert しても行数は増えない。"""
    conn = store.connect(tmp_path / "macro.sqlite")
    series = _series()
    store.upsert_series(conn, series)
    df = pd.DataFrame({"date": ["2020-01-01", "2020-01-02"], "value": [1.0, 2.0]})

    store.upsert_observations(conn, series.series_id, df)
    store.upsert_observations(conn, series.series_id, df)

    count = conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
    assert count == 2


def test_upsert_replaces_value(tmp_path):
    """既存の (series_id, date) は新しい値で REPLACE される。"""
    conn = store.connect(tmp_path / "macro.sqlite")
    series = _series()
    store.upsert_series(conn, series)

    store.upsert_observations(
        conn, series.series_id, pd.DataFrame({"date": ["2020-01-01"], "value": [1.0]})
    )
    store.upsert_observations(
        conn, series.series_id, pd.DataFrame({"date": ["2020-01-01"], "value": [9.0]})
    )

    value = conn.execute(
        "SELECT value FROM observations WHERE series_id=? AND date=?",
        (series.series_id, "2020-01-01"),
    ).fetchone()[0]
    count = conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
    assert value == 9.0
    assert count == 1


def test_log_fetch_records(tmp_path):
    """log_fetch が fetch_log に1行記録する。"""
    conn = store.connect(tmp_path / "macro.sqlite")
    store.log_fetch(conn, "FRED:TEST", "ok", "done")

    row = conn.execute(
        "SELECT series_id, status, message FROM fetch_log"
    ).fetchone()
    assert row == ("FRED:TEST", "ok", "done")

    ts = conn.execute("SELECT ts FROM fetch_log").fetchone()[0]
    assert isinstance(ts, str) and len(ts) > 0


def test_schema_has_three_tables(tmp_path):
    """series / observations / fetch_log の3テーブルを持つ。"""
    conn = store.connect(tmp_path / "macro.sqlite")
    tables = {
        r[0]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"series", "observations", "fetch_log"} <= tables
