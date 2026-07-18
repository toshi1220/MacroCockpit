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


def test_sanitize_passes_through_normal_message():
    assert sanitize("16119 observations") == "16119 observations"
