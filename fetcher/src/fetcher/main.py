"""全系列を取得し SQLite へ UPSERT するエントリポイント。

  python -m fetcher.main

1系列の失敗は fetch_log に 'error' を記録し logging.warning して継続する。
他の系列は処理を続け、プロセスは正常終了する。全系列が失敗した場合のみ
exit 1 とする。

Phase 2(SPEC §4.4 / §8): source='ib' の系列はまとめてワンショット接続
1回で取得する。IB セッション確立に失敗したら全IB系列を、個別の取得に
失敗したらその系列だけを、fallback_source(yfinance)へ自動フォールバック
する。フォールバックも失敗した場合のみ 'error' を記録する。取引システム
側に影響を与えないため、IB へのリトライは一切しない。
"""

from __future__ import annotations

import logging
import os
import re
import sys
from dataclasses import replace
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

from fetcher import store
from fetcher.registry import SERIES
from fetcher.sources import fred, yahoo

# ib は ib_async の導入不備(ImportError)が MVP 系列(fred/yahoo)の取得を
# 道連れにしないよう分離してimportする。失敗時は全IB系列がフォールバックする。
try:
    from fetcher.sources import ib
except ImportError as exc:
    ib = None  # type: ignore[assignment]
    _IB_IMPORT_ERROR: Exception | None = exc
else:
    _IB_IMPORT_ERROR = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("fetcher")

# source 名 -> 取得関数(fetch(series) -> DataFrame)。
# 'ib' はセッションを共有するため FETCHERS ではなく _fetch_ib_group で扱う。
FETCHERS = {
    "fred": fred.fetch,
    "yahoo": yahoo.fetch,
}

_API_KEY_RE = re.compile(r"api_key=[^&\s]+")


def sanitize(message: str) -> str:
    """fetch_log・ログ出力に載る文字列から api_key=... を伏せる(SPEC§10)。"""
    return _API_KEY_RE.sub("api_key=***", message)


def resolve_db_path() -> Path:
    """DBパスを解決する。

    環境変数 MACRO_DB_PATH があればそれを使う。無ければリポジトリ直下の
    data/macro.sqlite(main.py の __file__ から解決)。
    """
    env = os.environ.get("MACRO_DB_PATH")
    if env:
        return Path(env)
    # __file__: <repo>/fetcher/src/fetcher/main.py -> parents[3] = <repo>
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "data" / "macro.sqlite"


def _record_ok(conn, series, df, source_label: str, *, replace: bool = True) -> None:
    """取得成功を UPSERT + fetch_log に記録する。message に使用ソースを含める。

    replace=False はフォールバック用: 既存日付を上書きせず未収録分だけ埋める
    (重複期間は一次ソース=IB を優先。SPEC §8)。
    """
    store.upsert_series(conn, series)
    n = store.upsert_observations(conn, series.series_id, df, replace=replace)
    store.log_fetch(conn, series.series_id, "ok", f"{n} observations via {source_label}")
    logger.info("ok: %s (%d rows via %s)", series.series_id, n, source_label)


def _fetch_via_fallback(conn, series, note: str) -> bool:
    """fallback_source で取得する。成功なら True、失敗は 'error' を記録して False。

    note には一次ソース失敗の理由(sanitize 済み)を渡す。成功時の message は
    例: "365 observations via yahoo (ib session failed: ...)"。
    """
    try:
        if not series.fallback_source or not series.fallback_ref:
            raise RuntimeError("no fallback configured")
        fetcher_fn = FETCHERS.get(series.fallback_source)
        if fetcher_fn is None:
            raise RuntimeError(f"unknown fallback source: {series.fallback_source!r}")
        # 取得層の共通IFに合わせ、source_ref だけ差し替えた影武者を渡す。
        shadow = replace(series, source_ref=series.fallback_ref)
        df = fetcher_fn(shadow)
        # replace=False: 蓄積済みの一次ソース(IB)値をフォールバック値で
        # 上書きしない(重複期間は IB 優先。SPEC §8)。未収録日だけ埋める。
        _record_ok(conn, series, df, f"{series.fallback_source} ({note})", replace=False)
        return True
    except Exception as exc:  # noqa: BLE001 - フォールバック失敗も1系列の失敗として継続
        msg = sanitize(f"fallback {series.fallback_source} failed: {exc} ({note})")
        store.log_fetch(conn, series.series_id, "error", msg)
        logger.warning("error: %s: %s", series.series_id, msg)
        return False


def _fetch_ib_group(conn, ib_series) -> int:
    """IB系列群をワンショット接続1回でまとめて取得する。失敗系列数を返す。

    - セッション確立に失敗: 全IB系列を即フォールバック(IBへのリトライはしない)
    - セッション確立に成功: 系列ごとに取得し、個別失敗はその系列だけフォールバック
    """
    if not ib_series:
        return 0
    failures = 0
    if ib is None:
        note = sanitize(f"ib import failed: {_IB_IMPORT_ERROR}")
        logger.warning("fallback all ib series: %s", note)
        for series in ib_series:
            if not _fetch_via_fallback(conn, series, note):
                failures += 1
        return failures
    try:
        with ib.session() as ib_conn:
            for series in ib_series:
                try:
                    df = ib.fetch(series, ib_conn)
                    _record_ok(conn, series, df, "ib")
                except Exception as exc:  # noqa: BLE001 - 個別失敗は当該系列のみフォールバック
                    note = sanitize(f"ib fetch failed: {exc}")
                    logger.warning("fallback: %s: %s", series.series_id, note)
                    if not _fetch_via_fallback(conn, series, note):
                        failures += 1
    except Exception as exc:  # noqa: BLE001 - セッション確立失敗は全IB系列をフォールバック
        note = sanitize(f"ib session failed: {exc}")
        logger.warning("fallback all ib series: %s", note)
        for series in ib_series:
            if not _fetch_via_fallback(conn, series, note):
                failures += 1
    return failures


def main() -> int:
    load_dotenv(find_dotenv(usecwd=True))

    db_path = resolve_db_path()
    conn = store.connect(db_path)
    logger.info("db: %s", db_path)

    ib_series = [s for s in SERIES if s.source == "ib"]
    rest = [s for s in SERIES if s.source != "ib"]

    total = len(SERIES)
    failures = 0
    try:
        for series in rest:
            try:
                fetcher_fn = FETCHERS.get(series.source)
                if fetcher_fn is None:
                    raise RuntimeError(f"unknown source: {series.source!r}")
                df = fetcher_fn(series)
                _record_ok(conn, series, df, series.source)
            except Exception as exc:  # noqa: BLE001 - 1系列失敗は継続する
                failures += 1
                msg = sanitize(str(exc))
                store.log_fetch(conn, series.series_id, "error", msg)
                logger.warning("error: %s: %s", series.series_id, msg)

        failures += _fetch_ib_group(conn, ib_series)
    finally:
        conn.close()

    if total > 0 and failures == total:
        logger.error("all %d series failed", total)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
