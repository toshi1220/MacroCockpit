"""main のIB→yfinanceフォールバック機構のテスト(ネットワーク不要)。

sources(ib / FETCHERS)をモンキーパッチし、store は tmp_path 上の実SQLiteを
使う(MACRO_DB_PATH で差し替え)。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager

import pandas as pd
import pytest

from fetcher import main as main_mod
from fetcher.registry import Series


def _df(value: float = 1.0) -> pd.DataFrame:
    return pd.DataFrame({"date": ["2026-07-17"], "value": [value]})


_IB_GC = Series(
    series_id="YF:GC=F",
    source="ib",
    source_ref="ContFuture:GC:COMEX",
    name_ja="金先物",
    unit="USD",
    freq="D",
    fallback_source="yahoo",
    fallback_ref="GC=F",
)
_IB_FX = Series(
    series_id="YF:JPY=X",
    source="ib",
    source_ref="Forex:USDJPY",
    name_ja="USD/JPY(補助)",
    unit="円",
    freq="D",
    fallback_source="yahoo",
    fallback_ref="JPY=X",
)
_FRED = Series(
    series_id="FRED:DGS10",
    source="fred",
    source_ref="DGS10",
    name_ja="米10年金利",
    unit="%",
    freq="D",
)


@contextmanager
def _ok_session():
    yield object()  # fetch 側でしか使わないためダミーで良い


def _failing_session():
    raise RuntimeError("connection refused")


def _run_main(monkeypatch, tmp_path, *, series, ib_session, ib_fetch, yahoo_fetch, fred_fetch=None):
    db_path = tmp_path / "macro.sqlite"
    monkeypatch.setenv("MACRO_DB_PATH", str(db_path))
    monkeypatch.setattr(main_mod, "SERIES", series)
    monkeypatch.setattr(main_mod.ib, "session", ib_session)
    monkeypatch.setattr(main_mod.ib, "fetch", ib_fetch)
    monkeypatch.setattr(
        main_mod,
        "FETCHERS",
        {"yahoo": yahoo_fetch, "fred": fred_fetch or (lambda s: _df())},
    )
    rc = main_mod.main()
    conn = sqlite3.connect(db_path)
    log = {
        sid: (status, message)
        for sid, status, message in conn.execute(
            "SELECT series_id, status, message FROM fetch_log"
        )
    }
    sources = dict(conn.execute("SELECT series_id, source FROM series"))
    obs = conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
    conn.close()
    return rc, log, sources, obs


def test_session_failure_falls_back_all_ib_series(monkeypatch, tmp_path):
    """IBセッション確立失敗 → 全IB系列が yahoo で 'ok' になり、注記が残る。"""
    yahoo_refs = []

    def yahoo_fetch(series):
        yahoo_refs.append(series.source_ref)  # フォールバックrefで呼ばれること
        return _df()

    rc, log, sources, obs = _run_main(
        monkeypatch,
        tmp_path,
        series=[_IB_GC, _IB_FX],
        ib_session=_failing_session,
        ib_fetch=lambda s, c: pytest.fail("ib.fetch must not be called"),
        yahoo_fetch=yahoo_fetch,
    )

    assert rc == 0
    assert sorted(yahoo_refs) == ["GC=F", "JPY=X"]
    for sid in ("YF:GC=F", "YF:JPY=X"):
        status, message = log[sid]
        assert status == "ok"
        assert "via yahoo" in message
        assert "ib session failed" in message
        assert "connection refused" in message
        assert sources[sid] == "ib"  # DB上の一次ソース表記は 'ib' のまま
    assert obs == 2


def test_individual_failure_falls_back_only_that_series(monkeypatch, tmp_path):
    """IB個別失敗 → 当該系列のみ yahoo フォールバック、他はIBのまま。"""

    def ib_fetch(series, _conn):
        if series.series_id == "YF:JPY=X":
            raise RuntimeError("HMDS query timeout")
        return _df(2400.5)

    yahoo_calls = []

    def yahoo_fetch(series):
        yahoo_calls.append(series.source_ref)
        return _df(147.0)

    rc, log, _sources, obs = _run_main(
        monkeypatch,
        tmp_path,
        series=[_IB_GC, _IB_FX],
        ib_session=_ok_session,
        ib_fetch=ib_fetch,
        yahoo_fetch=yahoo_fetch,
    )

    assert rc == 0
    assert yahoo_calls == ["JPY=X"]  # GC はフォールバックされない
    assert log["YF:GC=F"][0] == "ok"
    assert log["YF:GC=F"][1] == "1 observations via ib"
    status, message = log["YF:JPY=X"]
    assert status == "ok"
    assert "via yahoo" in message
    assert "ib fetch failed" in message
    assert obs == 2


def test_fallback_does_not_overwrite_stored_ib_values(monkeypatch, tmp_path):
    """IB成功後の障害日にフォールバックが走っても、蓄積済みIB値は上書きされない。

    SPEC §8 受け入れ基準「系列の重複期間は公式ソース/IBを優先」の回帰テスト。
    yahoo は period=max で重複期間を返すが、既存日付は INSERT OR IGNORE で保持され、
    未収録日だけが埋まる。
    """
    db_path = tmp_path / "macro.sqlite"
    monkeypatch.setenv("MACRO_DB_PATH", str(db_path))
    monkeypatch.setattr(main_mod, "SERIES", [_IB_GC])

    # 1回目: IB 成功(2026-07-17 に IB の値 2400.5 を蓄積)
    monkeypatch.setattr(main_mod.ib, "session", _ok_session)
    monkeypatch.setattr(main_mod.ib, "fetch", lambda s, c: _df(2400.5))
    monkeypatch.setattr(main_mod, "FETCHERS", {"yahoo": lambda s: pytest.fail("no fallback expected")})
    assert main_mod.main() == 0

    # 2回目: IB 障害 → yahoo フォールバック(重複日 2026-07-17 は別値、新規日 2026-07-18 を追加)
    def yahoo_fetch(series):
        return pd.DataFrame(
            {"date": ["2026-07-17", "2026-07-18"], "value": [1111.0, 2402.0]}
        )

    monkeypatch.setattr(main_mod.ib, "session", _failing_session)
    monkeypatch.setattr(main_mod, "FETCHERS", {"yahoo": yahoo_fetch})
    assert main_mod.main() == 0

    conn = sqlite3.connect(db_path)
    rows = dict(
        conn.execute("SELECT date, value FROM observations WHERE series_id='YF:GC=F'")
    )
    messages = [
        m for (m,) in conn.execute("SELECT message FROM fetch_log WHERE status='ok'")
    ]
    conn.close()

    assert rows == {"2026-07-17": 2400.5, "2026-07-18": 2402.0}  # IB値が生き残る
    assert messages[0] == "1 observations via ib"
    assert "1 observations via yahoo" in messages[1]  # 新規1行のみ書き込み


def test_both_fail_records_error_and_continues(monkeypatch, tmp_path):
    """IBもフォールバックも失敗 → 'error' 記録。他系列(FRED)は継続して 'ok'。"""

    def ib_fetch(series, _conn):
        raise RuntimeError("HMDS query timeout")

    def yahoo_fetch(series):
        raise RuntimeError("YFRateLimitError: too many requests")

    rc, log, _sources, obs = _run_main(
        monkeypatch,
        tmp_path,
        series=[_IB_GC, _FRED],
        ib_session=_ok_session,
        ib_fetch=ib_fetch,
        yahoo_fetch=yahoo_fetch,
        fred_fetch=lambda s: _df(4.2),
    )

    assert rc == 0  # 全滅ではないので正常終了
    status, message = log["YF:GC=F"]
    assert status == "error"
    assert "fallback yahoo failed" in message
    assert "ib fetch failed" in message
    assert log["FRED:DGS10"] == ("ok", "1 observations via fred")
    assert obs == 1  # FRED の1行のみ
