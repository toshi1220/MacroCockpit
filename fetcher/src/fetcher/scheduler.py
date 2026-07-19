"""常駐スケジューラ: 毎日1回、指定時刻に main.main()(全系列取得)を実行する。

  python -m fetcher.scheduler

Docker 運用向け(docker-compose.yml の scheduler サービス)。SPEC §3 の
「常駐なし」は非 Docker 運用(cron + ワンショット)の思想だが、Docker では
ユーザー指示により cron 不要の常駐スケジューラへ意図的に変更した(README 参照)。

環境変数:
  FETCH_AT       毎日の実行時刻 "HH:MM"(既定 "06:30")。コンテナの TZ
                 (docker-compose.yml で TZ=Asia/Tokyo)のローカル時刻。
  FETCH_ON_START 真("1"/"true"/"yes" 等。既定 "1")なら起動直後にも1回実行
                 (コンテナ再起動時に即データが揃う)。

設計:
  - fetch の失敗(例外・exit 1 相当)でスケジューラ自体は死なない。
    logging.error して次のスケジュールへ継続する。
  - スリープは最大 600 秒のチャンクに分割する。time.sleep は monotonic 基準の
    ため、サスペンドや時計変更の後も最大600秒ごとに壁時計を再確認して
    過剰スリープから回復するのが目的(SIGTERM は sleep 中でも即座に効く)。
  - parse_fetch_at / next_run_at は純関数として分離(tests/test_scheduler.py)。
"""

from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timedelta

from fetcher import main as fetcher_main

logger = logging.getLogger("fetcher.scheduler")

# スリープ1回の最大長(秒)。SIGTERM への応答性のため長時間眠り続けない。
MAX_SLEEP_CHUNK = 600.0

_FETCH_AT_RE = re.compile(r"^(\d{1,2}):(\d{2})$")
_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"", "0", "false", "no", "off"}


def parse_fetch_at(s: str) -> tuple[int, int]:
    """"HH:MM" を (hour, minute) にして返す。不正形式は ValueError。"""
    m = _FETCH_AT_RE.match(s.strip())
    if not m:
        raise ValueError(f"FETCH_AT must be 'HH:MM' (e.g. '06:30'), got: {s!r}")
    hour, minute = int(m.group(1)), int(m.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"FETCH_AT out of range (00:00-23:59), got: {s!r}")
    return hour, minute


def next_run_at(now: datetime, hour: int, minute: int) -> datetime:
    """now から見た次回実行時刻。当日の HH:MM が未来ならそれ、過ぎていれば翌日。

    now がちょうど HH:MM ちょうど(同時刻)の場合は翌日(未来ではないため)。
    """
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate > now:
        return candidate
    return candidate + timedelta(days=1)


def _fetch_on_start_enabled(raw: str) -> bool:
    v = raw.strip().lower()
    if v in _TRUTHY:
        return True
    if v in _FALSY:
        return False
    raise ValueError(f"FETCH_ON_START must be boolean-like ('1'/'0' etc.), got: {raw!r}")


def run_fetch_once() -> None:
    """main.main() を1回実行する。失敗してもスケジューラは死なない。"""
    try:
        rc = fetcher_main.main()
        if rc != 0:
            logger.error("fetch finished with non-zero exit code %d; scheduler continues", rc)
    except Exception:  # noqa: BLE001 - fetch の失敗でスケジューラを殺さない
        logger.exception("fetch raised an exception; scheduler continues")


def sleep_until(target: datetime, *, _sleep=time.sleep, _now=datetime.now) -> None:
    """target まで眠る。最大 MAX_SLEEP_CHUNK 秒ずつに分割(SIGTERM 応答性)。"""
    while True:
        remaining = (target - _now()).total_seconds()
        if remaining <= 0:
            return
        _sleep(min(remaining, MAX_SLEEP_CHUNK))


def run_loop(
    hour: int,
    minute: int,
    fetch_on_start: bool,
    *,
    _sleep=time.sleep,
    _now=datetime.now,
) -> None:
    """常駐ループ。各実行の前後に次回実行時刻を logging.info で出す。"""
    if fetch_on_start:
        logger.info("FETCH_ON_START: running initial fetch now")
        run_fetch_once()
    while True:
        target = next_run_at(_now(), hour, minute)
        logger.info("next fetch scheduled at %s", target.isoformat(sep=" ", timespec="minutes"))
        sleep_until(target, _sleep=_sleep, _now=_now)
        run_fetch_once()
        logger.info(
            "fetch done; next fetch scheduled at %s",
            next_run_at(_now(), hour, minute).isoformat(sep=" ", timespec="minutes"),
        )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    hour, minute = parse_fetch_at(os.environ.get("FETCH_AT", "06:30"))
    fetch_on_start = _fetch_on_start_enabled(os.environ.get("FETCH_ON_START", "1"))
    logger.info(
        "scheduler start: daily fetch at %02d:%02d (TZ=%s), fetch_on_start=%s",
        hour,
        minute,
        os.environ.get("TZ", "system"),
        fetch_on_start,
    )
    run_loop(hour, minute, fetch_on_start)
    return 0  # 到達しない(run_loop は無限ループ)


if __name__ == "__main__":
    raise SystemExit(main())
