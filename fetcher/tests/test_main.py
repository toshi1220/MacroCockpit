"""main のユーティリティのテスト。"""

from __future__ import annotations

from fetcher.main import sanitize


def test_sanitize_masks_api_key():
    msg = (
        "400 Client Error: Bad Request for url: https://api.stlouisfed.org/"
        "fred/series/observations?series_id=DGS10&api_key=SECRETKEY123&file_type=json"
    )
    masked = sanitize(msg)
    assert "SECRETKEY123" not in masked
    assert "api_key=***" in masked


def test_sanitize_masks_app_id():
    """e-Stat の appId も伏せる(requests の通信例外に URL が載る経路)。"""
    msg = (
        "HTTPSConnectionPool(host='api.e-stat.go.jp', port=443): Max retries exceeded "
        "with url: /rest/3.0/app/json/getStatsData?appId=SECRETAPPID999&statsDataId=0003427113"
    )
    masked = sanitize(msg)
    assert "SECRETAPPID999" not in masked
    assert "appId=***" in masked


def test_sanitize_masks_both_keys_together():
    msg = "url?series_id=X&api_key=KEY1&appId=APP2&file_type=json"
    masked = sanitize(msg)
    assert "KEY1" not in masked
    assert "APP2" not in masked
    assert "api_key=***" in masked
    assert "appId=***" in masked


def test_sanitize_passes_through_normal_message():
    assert sanitize("16119 observations") == "16119 observations"
