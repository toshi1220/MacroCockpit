"""全系列を取得し SQLite へ UPSERT するエントリポイント。

  python -m fetcher.main

1系列の失敗は fetch_log に 'error' を記録し logging.warning して継続する。
他の系列は処理を続け、プロセスは正常終了する。全系列が失敗した場合のみ
exit 1 とする。
"""

from __future__ import annotations

import logging
import os
import re
import sys
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

from fetcher import store
from fetcher.registry import SERIES
from fetcher.sources import fred, yahoo

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("fetcher")

# source 名 -> 取得関数。
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


def main() -> int:
    load_dotenv(find_dotenv(usecwd=True))

    db_path = resolve_db_path()
    conn = store.connect(db_path)
    logger.info("db: %s", db_path)

    total = 0
    failures = 0
    try:
        for series in SERIES:
            total += 1
            try:
                fetcher_fn = FETCHERS.get(series.source)
                if fetcher_fn is None:
                    raise RuntimeError(f"unknown source: {series.source!r}")
                df = fetcher_fn(series)
                store.upsert_series(conn, series)
                n = store.upsert_observations(conn, series.series_id, df)
                store.log_fetch(conn, series.series_id, "ok", f"{n} observations")
                logger.info("ok: %s (%d rows)", series.series_id, n)
            except Exception as exc:  # noqa: BLE001 - 1系列失敗は継続する
                failures += 1
                msg = sanitize(str(exc))
                store.log_fetch(conn, series.series_id, "error", msg)
                logger.warning("error: %s: %s", series.series_id, msg)
    finally:
        conn.close()

    if total > 0 and failures == total:
        logger.error("all %d series failed", total)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
