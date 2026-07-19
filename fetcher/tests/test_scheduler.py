"""scheduler の純関数とループ継続のテスト(ネットワーク・DB 不要)。"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from fetcher import scheduler


# --- parse_fetch_at ----------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("06:30", (6, 30)),
        ("00:00", (0, 0)),
        ("23:59", (23, 59)),
        ("6:05", (6, 5)),  # 1桁時も許容
        ("  06:30  ", (6, 30)),  # 前後空白は無視
    ],
)
def test_parse_fetch_at_valid(raw, expected):
    assert scheduler.parse_fetch_at(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "0630",
        "6h30",
        "06:30:00",
        "24:00",  # 時が範囲外
        "12:60",  # 分が範囲外
        "-1:30",
        "06:3",  # 分は2桁必須
        "abc",
    ],
)
def test_parse_fetch_at_invalid(raw):
    with pytest.raises(ValueError):
        scheduler.parse_fetch_at(raw)


# --- _fetch_on_start_enabled -------------------------------------------------


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", "yes", "on"])
def test_fetch_on_start_truthy(raw):
    assert scheduler._fetch_on_start_enabled(raw) is True


@pytest.mark.parametrize("raw", ["0", "false", "False", "no", "off", ""])
def test_fetch_on_start_falsy(raw):
    # 空文字(FETCH_ON_START= のみ書かれた場合)は無効=falseと解釈する
    assert scheduler._fetch_on_start_enabled(raw) is False


@pytest.mark.parametrize("raw", ["2", "maybe", "はい"])
def test_fetch_on_start_invalid_raises(raw):
    # 未知値は起動時に明確に失敗させる(黙って既定動作にしない)
    with pytest.raises(ValueError):
        scheduler._fetch_on_start_enabled(raw)


# --- next_run_at -------------------------------------------------------------


def test_next_run_at_future_same_day():
    now = datetime(2026, 7, 19, 5, 0, 0)
    assert scheduler.next_run_at(now, 6, 30) == datetime(2026, 7, 19, 6, 30)


def test_next_run_at_just_before():
    """1秒前なら当日。"""
    now = datetime(2026, 7, 19, 6, 29, 59)
    assert scheduler.next_run_at(now, 6, 30) == datetime(2026, 7, 19, 6, 30)


def test_next_run_at_exactly_at_time_goes_to_next_day():
    """ちょうど HH:MM:00(同時刻)は未来ではないので翌日。"""
    now = datetime(2026, 7, 19, 6, 30, 0)
    assert scheduler.next_run_at(now, 6, 30) == datetime(2026, 7, 20, 6, 30)


def test_next_run_at_just_after_goes_to_next_day():
    now = datetime(2026, 7, 19, 6, 30, 0, 1)
    assert scheduler.next_run_at(now, 6, 30) == datetime(2026, 7, 20, 6, 30)


def test_next_run_at_crosses_month_boundary():
    """日跨ぎ(月末→翌月1日)。"""
    now = datetime(2026, 7, 31, 23, 0, 0)
    assert scheduler.next_run_at(now, 6, 30) == datetime(2026, 8, 1, 6, 30)


# --- sleep_until -------------------------------------------------------------


def test_sleep_until_chunks_max_600s():
    """長い待ちは最大600秒のチャンクに分割される。"""
    start = datetime(2026, 7, 19, 0, 0, 0)
    target = start + timedelta(seconds=1500)
    clock = {"now": start}
    slept: list[float] = []

    def fake_sleep(seconds: float) -> None:
        assert seconds <= scheduler.MAX_SLEEP_CHUNK
        slept.append(seconds)
        clock["now"] += timedelta(seconds=seconds)

    scheduler.sleep_until(target, _sleep=fake_sleep, _now=lambda: clock["now"])
    assert slept == [600.0, 600.0, 300.0]
    assert clock["now"] == target


def test_sleep_until_past_target_returns_immediately():
    def fail_sleep(_seconds: float) -> None:  # pragma: no cover
        raise AssertionError("should not sleep")

    now = datetime(2026, 7, 19, 12, 0, 0)
    scheduler.sleep_until(now - timedelta(seconds=1), _sleep=fail_sleep, _now=lambda: now)


# --- run_loop: fetch 失敗でもループ継続 --------------------------------------


class _Stop(Exception):
    """テスト用: 1周でループを打ち切るための番兵。"""


def test_run_loop_continues_after_fetch_exception(monkeypatch, caplog):
    """main.main() が例外を投げてもスケジューラは死なず、次のスケジュールに進む。"""
    calls = {"fetch": 0}

    def boom() -> int:
        calls["fetch"] += 1
        raise RuntimeError("fetch exploded")

    monkeypatch.setattr(scheduler.fetcher_main, "main", boom)

    def stop_sleep(_seconds: float) -> None:
        raise _Stop  # 次周の待機に入った=例外後もループが継続した証拠

    with caplog.at_level("ERROR", logger="fetcher.scheduler"):
        with pytest.raises(_Stop):
            scheduler.run_loop(6, 30, True, _sleep=stop_sleep)

    assert calls["fetch"] == 1  # 起動時 fetch は実行され、例外でも run_loop は継続した
    assert any("scheduler continues" in r.message for r in caplog.records)


def test_run_loop_logs_error_on_nonzero_exit(monkeypatch, caplog):
    """main.main() が exit 1 相当を返しても死なずに継続する。"""
    monkeypatch.setattr(scheduler.fetcher_main, "main", lambda: 1)

    def stop_sleep(_seconds: float) -> None:
        raise _Stop

    with caplog.at_level("ERROR", logger="fetcher.scheduler"):
        with pytest.raises(_Stop):
            scheduler.run_loop(6, 30, True, _sleep=stop_sleep)

    assert any("non-zero exit code 1" in r.message for r in caplog.records)


def test_run_loop_logs_next_run_and_skips_start_fetch(monkeypatch, caplog):
    """FETCH_ON_START が偽なら起動時 fetch はせず、次回実行時刻をログして待機に入る。"""
    monkeypatch.setattr(
        scheduler.fetcher_main,
        "main",
        lambda: (_ for _ in ()).throw(AssertionError("should not fetch")),
    )

    def stop_sleep(_seconds: float) -> None:
        raise _Stop

    fixed_now = datetime(2026, 7, 19, 5, 0, 0)
    with caplog.at_level("INFO", logger="fetcher.scheduler"):
        with pytest.raises(_Stop):
            scheduler.run_loop(6, 30, False, _sleep=stop_sleep, _now=lambda: fixed_now)

    assert any("next fetch scheduled at 2026-07-19 06:30" in r.message for r in caplog.records)
